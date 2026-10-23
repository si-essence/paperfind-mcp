import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { loadConfig } from "../src/config.js";
import type { Logger } from "../src/log.js";
import { createRuntime } from "../src/runtime.js";
import { connectServer } from "./mcp.js";
import { routeFixture } from "./fixtures.js";
import { readToolText } from "./result.js";

const ALLOWED_HOSTS = [
  "export.arxiv.org",
  "api.crossref.org",
  "api.openalex.org",
  "www.ebi.ac.uk",
  "eutils.ncbi.nlm.nih.gov",
  "doaj.org",
  "api.unpaywall.org",
];

export interface Hit {
  url: string;
  at: number;
  headers: Headers;
}

export interface Session {
  client: Client;
  hits: Hit[];
  sleeps: number[];
  peakInflight: () => number;
  close: () => Promise<void>;
}

export async function startPapers(
  options: {
    env?: NodeJS.ProcessEnv;
    router?: (url: URL) => Response | Promise<Response>;
    perMinute?: string;
    cacheTtlSec?: string;
    random?: () => number;
    logger?: Logger;
  } = {},
): Promise<Session> {
  const hits: Hit[] = [];
  const sleeps: number[] = [];
  let now = 0;
  let current = 0;
  let peak = 0;
  const router = options.router ?? routeFixture;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(requestUrl(input));
    current += 1;
    peak = Math.max(peak, current);
    hits.push({ url: url.toString(), at: now, headers: new Headers(init?.headers) });
    try {
      return await router(url);
    } finally {
      current -= 1;
    }
  };
  const env: NodeJS.ProcessEnv = {
    PAPERS_PER_MINUTE: "1000",
    PAPERS_CACHE_TTL_SEC: "0",
    ...options.env,
  };
  if (options.perMinute !== undefined) env["PAPERS_PER_MINUTE"] = options.perMinute;
  if (options.cacheTtlSec !== undefined) env["PAPERS_CACHE_TTL_SEC"] = options.cacheTtlSec;
  const runtime = createRuntime(loadConfig(env, []), {
    fetchImpl,
    now: () => now,
    sleep: (ms) => {
      sleeps.push(ms);
      now += ms;
      return Promise.resolve();
    },
    random: options.random ?? (() => 0),
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  });
  const connected = await connectServer(runtime);
  return {
    client: connected.client,
    hits,
    sleeps,
    peakInflight: () => peak,
    close: connected.close,
  };
}

export async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<{ text: string; isError: boolean }> {
  return readToolText(await client.callTool({ name, arguments: args }));
}

export function assertNoPdfFetches(hits: readonly Hit[]): void {
  for (const hit of hits) {
    const url = new URL(hit.url);
    if (!ALLOWED_HOSTS.includes(url.hostname)) {
      throw new Error(`fetch left the allowlist: ${url.hostname}`);
    }
    if (url.protocol !== "https:") throw new Error(`fetch was not https: ${url.protocol}`);
    const path = url.pathname.toLowerCase();
    if (path.endsWith(".pdf") || path.includes("/pdf")) {
      throw new Error(`fetch requested a PDF: ${url.pathname}`);
    }
  }
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}
