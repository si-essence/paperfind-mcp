import type { Secret } from "./brand.js";
import { TtlCache } from "./cache.js";
import { ConnectorError } from "./errors.js";
import type { Logger } from "./log.js";
import type { UpstreamId } from "./paper.js";
import type { RateLimiter } from "./rate-limit.js";
import { redact, stripUrls } from "./redact.js";
import type { WaitingScheduler } from "./schedule.js";

const MAX_BODY = 1_000_000;
const MAX_ATTEMPTS = 3;

const ALLOWED_HOSTS: Readonly<Record<string, (pathname: string) => boolean>> = {
  "export.arxiv.org": (pathname) => pathname.startsWith("/api/"),
  "api.crossref.org": (pathname) => pathname.startsWith("/works"),
  "api.openalex.org": (pathname) =>
    pathname.startsWith("/works") || pathname.startsWith("/authors"),
  "www.ebi.ac.uk": (pathname) => pathname.startsWith("/europepmc/"),
  "eutils.ncbi.nlm.nih.gov": (pathname) => pathname.startsWith("/entrez/eutils/"),
  "doaj.org": (pathname) => pathname.startsWith("/api/"),
  "api.unpaywall.org": (pathname) => pathname.startsWith("/v2/"),
};

export interface UpstreamCall {
  source: UpstreamId;
  url: string;
  accept: string;
  headers?: Readonly<Record<string, string>>;
  scheduler: WaitingScheduler;
  cacheTtlSec: number;
}

export interface UpstreamText {
  text: string;
  status: number;
}

export interface UpstreamOptions {
  fetchImpl: typeof fetch;
  timeoutMs: number;
  secrets: readonly string[];
  cache: TtlCache;
  inbound: RateLimiter;
  userAgent: string;
  logger: Logger;
  sleep: (ms: number) => Promise<void>;
  random: () => number;
}

export class Upstream {
  constructor(private readonly options: UpstreamOptions) {}

  async getText(call: UpstreamCall): Promise<UpstreamText> {
    const url = this.allow(call.url);
    const cacheKey = `GET ${url.toString()}`;
    const cached = this.options.cache.get(cacheKey);
    if (typeof cached === "string") return { text: cached, status: 200 };

    this.options.inbound.acquire();
    const result = await call.scheduler.run(() => this.fetchWithRetry(call.source, url, call));
    if (call.cacheTtlSec > 0) {
      this.options.cache.set(cacheKey, result.text, call.cacheTtlSec);
    }
    return result;
  }

  private allow(raw: string): URL {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new ConnectorError("invalid_input", "Refusing a request URL that is not absolute.");
    }
    if (url.protocol !== "https:") {
      throw new ConnectorError("invalid_input", "Refusing a request that is not HTTPS.");
    }
    if (url.username !== "" || url.password !== "") {
      throw new ConnectorError("invalid_input", "Refusing a request URL with userinfo.");
    }
    const host = url.hostname.toLowerCase();
    const rule = ALLOWED_HOSTS[host];
    if (rule === undefined || !rule(url.pathname)) {
      throw new ConnectorError("invalid_input", `Refusing a request to ${host}.`);
    }
    if (isPdfPath(url.pathname) || (host.endsWith("arxiv.org") && url.pathname.includes("/pdf"))) {
      throw new ConnectorError("invalid_input", "Refusing to fetch a PDF.");
    }
    this.rejectSecretOutsideApiKey(url);
    return url;
  }

  private rejectSecretOutsideApiKey(url: URL): void {
    const params = [...url.searchParams.entries()];
    for (const secret of this.options.secrets) {
      if (secret.length < 8) continue;
      const encoded = encodeURIComponent(secret);
      const pathHasSecret = url.pathname.includes(secret) || url.pathname.includes(encoded);
      if (pathHasSecret) {
        throw new ConnectorError("config", "Refusing to place a secret in the request URL.");
      }
      for (const [key, value] of params) {
        if (key.toLowerCase() === "api_key" && (value === secret || value === encoded)) continue;
        if (value.includes(secret) || value.includes(encoded)) {
          throw new ConnectorError("config", "Refusing to place a secret in the request URL.");
        }
      }
    }
  }

  private async fetchWithRetry(
    source: UpstreamId,
    url: URL,
    call: UpstreamCall,
  ): Promise<UpstreamText> {
    let lastError: ConnectorError | undefined;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      if (attempt > 0) {
        const wait = backoffMs(
          attempt - 1,
          lastError?.retryAfterSeconds ?? null,
          this.options.random,
        );
        await this.options.sleep(wait);
      }
      let response: Response;
      try {
        response = await this.send(url, call);
      } catch (error) {
        const wrapped = asConnectorError(error, source);
        if (!shouldRetryError(wrapped) || attempt === MAX_ATTEMPTS - 1) throw wrapped;
        lastError = wrapped;
        continue;
      }
      this.observeRateLimit(response, call.scheduler);
      if (response.ok) {
        const text = await readLimited(response, source, this.options.secrets);
        if (looksLikeHtml(text)) {
          throw new ConnectorError(
            "upstream_unavailable",
            `${source} returned an HTML page instead of data.`,
          );
        }
        return { text: redact(text, this.options.secrets), status: response.status };
      }
      const error = await this.httpError(source, response);
      if (!shouldRetryStatus(response.status) || attempt === MAX_ATTEMPTS - 1) throw error;
      lastError = error;
    }
    throw lastError ?? new ConnectorError("upstream_unavailable", `${source} request failed.`);
  }

  private async send(url: URL, call: UpstreamCall): Promise<Response> {
    const headers = new Headers();
    headers.set("accept", call.accept);
    headers.set("user-agent", this.options.userAgent);
    if (call.headers !== undefined) {
      for (const [key, value] of Object.entries(call.headers)) headers.set(key, value);
    }
    try {
      return await this.options.fetchImpl(url, {
        method: "GET",
        headers,
        redirect: "manual",
        signal: AbortSignal.timeout(this.options.timeoutMs),
      });
    } catch (error) {
      throw networkError(error, call.source, this.options.timeoutMs, this.options.secrets);
    }
  }

  private observeRateLimit(response: Response, scheduler: WaitingScheduler): void {
    const intervalMs = rateIntervalMs(response.headers);
    if (intervalMs !== undefined) scheduler.tighten(intervalMs);
  }

  private async httpError(source: UpstreamId, response: Response): Promise<ConnectorError> {
    const text = await readLimited(response, source, this.options.secrets).catch(() => "");
    const snippet = publicSnippet(text, this.options.secrets);
    const detail = snippet.length > 0 ? `: ${snippet}` : "";
    if (response.status >= 300 && response.status < 400) {
      return new ConnectorError(
        "upstream_unavailable",
        `${source} HTTP ${response.status}: refusing a redirect.`,
      );
    }
    if (response.status === 404) {
      return new ConnectorError("not_found", `${source} HTTP 404${detail}`);
    }
    if (response.status === 429) {
      return new ConnectorError(
        "rate_limited",
        `${source} HTTP 429${detail}`,
        retryAfterSeconds(response),
      );
    }
    this.options.logger.error(`${source} HTTP ${response.status}${detail}`);
    return new ConnectorError("upstream_unavailable", `${source} HTTP ${response.status}${detail}`);
  }
}

export function bearer(secret: Secret | undefined): Readonly<Record<string, string>> | undefined {
  if (secret === undefined) return undefined;
  return { authorization: `Bearer ${secret}` };
}

function isPdfPath(pathname: string): boolean {
  return pathname.toLowerCase().endsWith(".pdf") || pathname.toLowerCase().includes("/pdf/");
}

function shouldRetryStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function shouldRetryError(error: ConnectorError): boolean {
  return error.code === "timeout" || error.code === "upstream_unavailable";
}

function asConnectorError(error: unknown, source: UpstreamId): ConnectorError {
  if (error instanceof ConnectorError) return error;
  const raw = error instanceof Error ? error.message : "request failed";
  return new ConnectorError("upstream_unavailable", `${source} request failed: ${raw}`);
}

function networkError(
  error: unknown,
  source: UpstreamId,
  timeoutMs: number,
  secrets: readonly string[],
): ConnectorError {
  if (error instanceof ConnectorError) return error;
  const name = error instanceof Error ? error.name : "";
  if (name === "TimeoutError" || name === "AbortError") {
    const seconds = Math.max(1, Math.round(timeoutMs / 1000));
    return new ConnectorError("timeout", `${source} request timed out after ${seconds}s.`);
  }
  const raw = error instanceof Error ? error.message : "network error";
  return new ConnectorError(
    "upstream_unavailable",
    `${source} request failed: ${publicSnippet(raw, secrets)}`,
  );
}

function backoffMs(attempt: number, retryAfterSecondsValue: number | null, random: () => number): number {
  if (retryAfterSecondsValue !== null && retryAfterSecondsValue > 0) {
    return Math.min(retryAfterSecondsValue * 1000, 30_000);
  }
  const base = 200 * 2 ** attempt;
  const jitter = 0.5 + random() * 0.5;
  return Math.min(Math.round(base * jitter), 10_000);
}

function rateIntervalMs(headers: Headers): number | undefined {
  const limitRaw = headers.get("x-rate-limit-limit");
  const intervalRaw = headers.get("x-rate-limit-interval");
  if (limitRaw === null || intervalRaw === null) return undefined;
  const limit = Number(limitRaw);
  const seconds = parseIntervalSeconds(intervalRaw);
  if (!Number.isFinite(limit) || limit <= 0 || seconds === undefined) return undefined;
  return Math.ceil((seconds * 1000) / limit);
}

function parseIntervalSeconds(raw: string): number | undefined {
  const match = /^(\d+(?:\.\d+)?)(s|ms)?$/.exec(raw.trim());
  if (match?.[1] === undefined) return undefined;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return undefined;
  if (match[2] === "ms") return amount / 1000;
  return amount;
}

function publicSnippet(text: string, secrets: readonly string[]): string {
  return stripUrls(redact(text, secrets)).replace(/\s+/g, " ").trim().slice(0, 180);
}

function looksLikeHtml(text: string): boolean {
  return /^\s*<!doctype html|^\s*<html[\s>]/i.test(text);
}

function retryAfterSeconds(response: Response): number | null {
  const raw = response.headers.get("retry-after");
  if (raw === null) return null;
  if (/^[0-9]+$/.test(raw)) {
    const seconds = Number(raw);
    return seconds > 0 ? seconds : null;
  }
  const when = Date.parse(raw);
  if (Number.isNaN(when)) return null;
  return Math.max(1, Math.ceil((when - Date.now()) / 1000));
}

async function readLimited(
  response: Response,
  source: UpstreamId,
  secrets: readonly string[],
): Promise<string> {
  const declared = response.headers.get("content-length");
  if (declared !== null && /^[0-9]+$/.test(declared) && Number(declared) > MAX_BODY) {
    await response.body?.cancel().catch(() => undefined);
    throw new ConnectorError("upstream_unavailable", `${source} response was too large to parse.`);
  }
  let text = "";
  try {
    text = await response.text();
  } catch (error) {
    const raw = error instanceof Error ? error.message : "unreadable";
    throw new ConnectorError(
      "upstream_unavailable",
      `${source} response could not be read: ${publicSnippet(raw, secrets)}`,
    );
  }
  if (text.length > MAX_BODY) {
    throw new ConnectorError("upstream_unavailable", `${source} response was too large to parse.`);
  }
  return text;
}
