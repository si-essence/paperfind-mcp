#!/usr/bin/env node
/**
 * Sequential live check. Spawns dist/index.js over stdio and calls each source once.
 * Prints a pass/fail table. Never prints OPENALEX_API_KEY or NCBI_API_KEY.
 * Exits 0 after the table even when a source fails. Exits 1 only when the server
 * cannot start.
 */
import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const CALL_MS = 90_000;
const FALLBACK_DOI = "10.1371/journal.pone.0000217";
const SECRET_NAMES = ["OPENALEX_API_KEY", "NCBI_API_KEY"];

/** @type {string[]} */
const secrets = [];
for (const name of SECRET_NAMES) {
  const value = process.env[name];
  if (typeof value === "string" && value.length > 0) secrets.push(value);
}

/**
 * @param {string} text
 */
function redact(text) {
  let out = String(text);
  for (const secret of secrets) {
    out = out.split(secret).join("[redacted]");
    out = out.split(encodeURIComponent(secret)).join("[redacted]");
  }
  out = out.replace(/api_key=[^&\s"]+/gi, "api_key=[redacted]");
  out = out.replace(/Bearer\s+\S+/gi, "Bearer [redacted]");
  return out;
}

/**
 * @param {string} text
 */
function clip(text) {
  const cleaned = redact(text).replace(/\s+/g, " ").trim();
  if (cleaned.length > 400) return `${cleaned.slice(0, 397)}...`;
  return cleaned;
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function childEnv() {
  /** @type {Record<string, string>} */
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") env[key] = value;
  }
  env["PAPERS_CONTACT_EMAIL"] = "contact@example.com";
  env["PAPERS_TIMEOUT_MS"] = "25000";
  env["PAPERS_CACHE_TTL_SEC"] = "0";
  env["PAPERS_PER_MINUTE"] = "60";
  env["MCP_TRANSPORT"] = "stdio";
  return env;
}

/**
 * @param {Promise<T>} promise
 * @param {number} ms
 * @template T
 */
function withTimeout(promise, ms) {
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`timed out after ${ms}ms`));
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

/**
 * @param {import("@modelcontextprotocol/sdk/types.js").CallToolResult} result
 */
function toolText(result) {
  const block = Array.isArray(result.content) ? result.content[0] : undefined;
  if (block && typeof block === "object" && "text" in block && typeof block.text === "string") {
    return block.text;
  }
  return "";
}

/**
 * @param {import("@modelcontextprotocol/sdk/client/index.js").Client} client
 * @param {string} name
 * @param {Record<string, unknown>} args
 */
async function callTool(client, name, args) {
  const started = Date.now();
  try {
    const result = await withTimeout(client.callTool({ name, arguments: args }), CALL_MS);
    const text = redact(toolText(result));
    /** @type {Record<string, unknown> | null} */
    let json = null;
    if (result.isError !== true && text.startsWith("{")) {
      try {
        const parsed = JSON.parse(text);
        json = isRecord(parsed) ? parsed : null;
      } catch {
        json = null;
      }
    }
    return { ms: Date.now() - started, isError: result.isError === true, text: clip(text), json };
  } catch (error) {
    const message = error instanceof Error ? error.message : "call failed";
    return { ms: Date.now() - started, isError: true, text: clip(message), json: null };
  }
}

/**
 * @param {Record<string, unknown> | null} json
 */
function paperCount(json) {
  const papers = json?.["papers"];
  return Array.isArray(papers) ? papers.length : 0;
}

/**
 * @param {Record<string, unknown> | null} json
 */
function firstDoi(json) {
  const papers = json?.["papers"];
  if (!Array.isArray(papers)) return undefined;
  for (const paper of papers) {
    if (!isRecord(paper)) continue;
    const ids = paper["ids"];
    if (isRecord(ids) && typeof ids["doi"] === "string" && ids["doi"].length > 0) {
      return ids["doi"];
    }
  }
  return undefined;
}

/**
 * @param {Record<string, unknown> | null} json
 */
function statusDetail(json) {
  const statuses = json?.["statuses"];
  const one = json?.["status"];
  const list = Array.isArray(statuses) ? statuses : one === undefined ? [] : [one];
  const parts = [];
  for (const item of list) {
    if (!isRecord(item)) continue;
    const source = typeof item["source"] === "string" ? item["source"] : "?";
    const status = typeof item["status"] === "string" ? item["status"] : "?";
    const message = typeof item["message"] === "string" ? item["message"] : "";
    parts.push(message.length > 0 ? `${source}=${status}:${message}` : `${source}=${status}`);
  }
  return parts.join(" ");
}

async function main() {
  try {
    await access(new URL("../dist/index.js", import.meta.url));
  } catch {
    console.log("FAIL  startup  dist/index.js is missing. Run npm run build first.");
    process.exit(1);
  }

  for (const secret of secrets) {
    if (redact(`token ${secret} ${encodeURIComponent(secret)}`).includes(secret)) {
      console.log("FAIL  startup  redaction failed");
      process.exit(1);
    }
  }

  const keyLine = SECRET_NAMES.map((name) => {
    const value = process.env[name];
    const set = typeof value === "string" && value.length > 0;
    return `${name}=${set ? "set" : "unset"}`;
  }).join(" ");
  console.log(`papers live-check  contact=contact@example.com  ${keyLine}`);

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["dist/index.js"],
    cwd: root,
    env: childEnv(),
    stderr: "pipe",
  });
  const stderr = transport.stderr;
  if (stderr && "on" in stderr) {
    stderr.on("data", (chunk) => {
      const text = clip(String(chunk));
      if (text.length === 0) return;
      if (text.includes("NO_COLOR") && text.includes("FORCE_COLOR")) return;
      console.error(`server_stderr ${text}`);
    });
  }

  const client = new Client({ name: "papers-live-check", version: "0" });
  try {
    await withTimeout(client.connect(transport), CALL_MS);
  } catch (error) {
    const message = error instanceof Error ? error.message : "connect failed";
    console.log(`FAIL  startup  ${clip(message)}`);
    process.exit(1);
  }

  /** @type {string[]} */
  const rows = ["source       result  count  ms     detail"];
  /** @type {string | undefined} */
  let doi;

  const searches = ["arxiv", "crossref", "openalex", "europepmc", "pubmed", "doaj"];

  try {
    for (const source of searches) {
      const result = await callTool(client, "search_source", {
        source,
        query: "graphene",
        limit: 1,
      });
      const count = paperCount(result.json);
      doi ??= firstDoi(result.json);
      const ok = !result.isError && count > 0;
      const detail = result.isError
        ? result.text
        : `count=${count} ${statusDetail(result.json)}`.trim();
      rows.push(formatRow(source, ok ? "PASS" : "FAIL", count, result.ms, detail));
    }

    const oaDoi = doi ?? FALLBACK_DOI;
    const oa = await callTool(client, "find_open_access", { doi: oaDoi });
    const locations = oa.json?.["locations"];
    const count = Array.isArray(locations) ? locations.length : 0;
    const reason = typeof oa.json?.["reason"] === "string" ? oa.json["reason"] : "";
    const detail = oa.isError
      ? oa.text
      : `doi=${oaDoi} isOa=${String(oa.json?.["isOa"])} locations=${count} ${reason} ${statusDetail(oa.json)}`.trim();
    rows.push(formatRow("unpaywall", oa.isError ? "FAIL" : "PASS", count, oa.ms, detail));
  } finally {
    await client.close().catch(() => undefined);
  }

  console.log(rows.join("\n"));
}

/**
 * @param {string} source
 * @param {string} result
 * @param {number} count
 * @param {number} ms
 * @param {string} detail
 */
function formatRow(source, result, count, ms, detail) {
  const name = source.padEnd(12, " ");
  const flag = result.padEnd(6, " ");
  const hits = String(count).padEnd(6, " ");
  const time = String(ms).padEnd(6, " ");
  return `${name} ${flag} ${hits} ${time} ${clip(detail)}`;
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : "live-check failed";
  console.log(`FAIL  startup  ${clip(message)}`);
  process.exit(1);
});
