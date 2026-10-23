import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { createLogger } from "../src/log.js";
import { redact, redactUnknown } from "../src/redact.js";
import { createRuntime } from "../src/runtime.js";
import { connectServer } from "./mcp.js";
import { readToolText } from "./result.js";

const KEY = "super-secret/key+value=99";
const ENCODED = encodeURIComponent(KEY);

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function assertNoKey(label: string, text: string): void {
  expect(text, label).not.toContain(KEY);
  expect(text, label).not.toContain(ENCODED);
}

describe("redact", () => {
  it("strips the secret, its url encoding, query params, and bearer tokens", () => {
    const raw = [
      `key=${KEY}`,
      `encoded=${ENCODED}`,
      `https://upstream.test/lookup?api_key=${KEY}&x=1`,
      `Authorization: Bearer ${KEY}`,
    ].join("\n");
    const cleaned = redact(raw, [KEY]);
    assertNoKey("redact", cleaned);
    expect(cleaned).toContain("api_key=[redacted]");
    expect(cleaned).toContain("Bearer [redacted]");
  });

  it("redacts nested strings and object keys", () => {
    const cleaned = JSON.stringify(redactUnknown({ [KEY]: [{ title: `see ${KEY}` }] }, [KEY]));
    assertNoKey("nested", cleaned);
    expect(cleaned).toContain("[redacted]");
  });

  it("redacts logger lines", () => {
    const lines: string[] = [];
    const logger = createLogger([KEY], (line) => {
      lines.push(line);
    });
    logger.error(`upstream said ${KEY}`);
    assertNoKey("logger", lines.join("\n"));
    expect(lines.join("\n")).toContain("[redacted]");
  });

  it("keeps an OpenAlex bearer token out of URLs, tool output, errors, and logs", async () => {
    const logs: string[] = [];
    const consoleLines: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      consoleLines.push(
        args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "),
      );
    });
    let call = 0;
    const fetchImpl = vi.fn<typeof fetch>((input, init) => {
      const url = requestUrl(input);
      assertNoKey("request url", url);
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${KEY}`);
      call += 1;
      if (call === 1) {
        return Promise.resolve(
          Response.json({
            results: [{ id: "https://openalex.org/W1", display_name: `hello ${KEY}` }],
          }),
        );
      }
      return Promise.reject(new Error(`connect failed ${KEY} ${ENCODED}`));
    });
    const runtime = createRuntime(
      loadConfig(
        { OPENALEX_API_KEY: KEY, PAPERS_CACHE_TTL_SEC: "0", PAPERS_PER_MINUTE: "100" },
        [],
      ),
      {
        fetchImpl,
        logger: createLogger([KEY], (line) => {
          logs.push(line);
        }),
      },
    );
    const { client, close } = await connectServer(runtime);
    try {
      const ok = readToolText(
        await client.callTool({
          name: "search_source",
          arguments: { source: "openalex", query: "widget" },
        }),
      );
      const bad = readToolText(
        await client.callTool({
          name: "search_source",
          arguments: { source: "openalex", query: "other" },
        }),
      );
      const invalid = readToolText(
        await client.callTool({
          name: "search_source",
          arguments: { source: "openalex", query: `${KEY}${"x".repeat(300)}` },
        }),
      );
      expect(ok.isError).toBe(false);
      expect(ok.text).toContain("[redacted]");
      assertNoKey("success output", ok.text);
      expect(bad.isError).toBe(true);
      expect(bad.text).toContain("[redacted]");
      assertNoKey("error output", bad.text);
      expect(invalid.isError).toBe(true);
      assertNoKey("validation error", invalid.text);
      expect(logs.length).toBeGreaterThan(0);
      assertNoKey("logs", logs.join("\n"));
      assertNoKey("stderr", consoleLines.join("\n"));
      // One success, then a network error retried up to the attempt cap.
      expect(fetchImpl).toHaveBeenCalledTimes(4);
    } finally {
      spy.mockRestore();
      await close();
    }
  });

  it("allows an NCBI api_key on the request URL and still redacts it from output", async () => {
    const logs: string[] = [];
    const fetchImpl = vi.fn<typeof fetch>((input) => {
      const url = requestUrl(input);
      expect(url.includes("api_key=")).toBe(true);
      if (url.includes("esearch")) {
        return Promise.resolve(Response.json({ esearchresult: { idlist: ["12345"] } }));
      }
      const body = `<PubmedArticleSet><PubmedArticle><MedlineCitation><PMID>12345</PMID><Article><ArticleTitle>hello ${KEY}</ArticleTitle><Journal><Title>J</Title><JournalIssue><PubDate><Year>2020</Year></PubDate></JournalIssue></Journal></Article></MedlineCitation></PubmedArticle></PubmedArticleSet>`;
      return Promise.resolve(new Response(body, { status: 200 }));
    });
    const runtime = createRuntime(
      loadConfig({ NCBI_API_KEY: KEY, PAPERS_CACHE_TTL_SEC: "0", PAPERS_PER_MINUTE: "100" }, []),
      {
        fetchImpl,
        logger: createLogger([KEY], (line) => {
          logs.push(line);
        }),
      },
    );
    const { client, close } = await connectServer(runtime);
    try {
      const ok = readToolText(
        await client.callTool({
          name: "search_source",
          arguments: { source: "pubmed", query: "widget" },
        }),
      );
      const listed = readToolText(await client.callTool({ name: "list_sources", arguments: {} }));
      expect(ok.isError).toBe(false);
      expect(ok.text).toContain("[redacted]");
      assertNoKey("pubmed output", ok.text);
      expect(listed.text).toContain("NCBI_API_KEY");
      expect(listed.text).toContain('"set":true');
      assertNoKey("list_sources", listed.text);
      assertNoKey("logs", logs.join("\n"));
    } finally {
      await close();
    }
  });
});
