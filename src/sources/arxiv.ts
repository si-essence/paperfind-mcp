import { z } from "zod";
import type { SearchRequest, SourceContext } from "../context.js";
import { ConnectorError } from "../errors.js";
import { makePaper, normalizeArxivId, normalizeDoi, type Paper } from "../paper.js";
import { asArray, asRecord, asString, attr, textContent, withQuery } from "../values.js";
import { parseXml } from "../xml.js";

const feedSchema = z.object({
  feed: z.unknown().optional(),
});

export async function searchArxiv(ctx: SourceContext, request: SearchRequest): Promise<Paper[]> {
  const url = withQuery("https://export.arxiv.org/api/query", {
    search_query: arxivQuery(request),
    start: 0,
    max_results: request.limit,
  });
  return papersFromFeed(await fetchFeed(ctx, url));
}

export async function getArxiv(ctx: SourceContext, rawId: string): Promise<Paper> {
  const id = normalizeArxivId(rawId);
  if (id === undefined) {
    throw new ConnectorError("invalid_input", "arxiv id is not a valid arXiv identifier.");
  }
  const url = withQuery("https://export.arxiv.org/api/query", { id_list: id });
  const papers = papersFromFeed(await fetchFeed(ctx, url));
  const paper = papers[0];
  if (paper === undefined) {
    throw new ConnectorError("not_found", `arxiv has no record for ${id}.`);
  }
  return paper;
}

async function fetchFeed(ctx: SourceContext, url: string): Promise<string> {
  const response = await ctx.upstream.getText({
    source: "arxiv",
    url,
    accept: "application/atom+xml",
    scheduler: ctx.schedulers.arxiv,
    cacheTtlSec: ctx.config.cacheTtlSec,
  });
  return response.text;
}

export function papersFromFeed(xml: string): Paper[] {
  const parsed = feedSchema.safeParse(parseXml(xml));
  if (!parsed.success) {
    throw new ConnectorError("upstream_unavailable", "arxiv response did not match the expected shape.");
  }
  const feed = asRecord(parsed.data.feed);
  const papers: Paper[] = [];
  for (const entry of asArray(feed?.["entry"])) {
    const paper = paperFromEntry(entry);
    if (paper !== undefined) papers.push(paper);
  }
  return papers;
}

function paperFromEntry(entry: unknown): Paper | undefined {
  const record = asRecord(entry);
  if (record === undefined) return undefined;
  const rawId = textContent(record["id"]) ?? asString(record["id"]);
  if (rawId === undefined || rawId.includes("/api/errors")) return undefined;
  const title = clean(textContent(record["title"]) ?? asString(record["title"]));
  if (title === undefined) return undefined;
  const arxivId = normalizeArxivId(rawId);
  const abs = absUrl(record, arxivId);
  const pdfUrl = pdfLink(record);
  const published = asString(record["published"]);
  const summary = clean(textContent(record["summary"]) ?? asString(record["summary"]));
  const doi = normalizeDoi(asString(record["doi"]));
  const venue = clean(asString(record["journal_ref"]));
  const paper = makePaper({
    ids: {
      ...(arxivId === undefined ? {} : { arxivId }),
      ...(doi === undefined ? {} : { doi }),
    },
    title,
    authors: authorsFrom(record["author"]),
    sources: ["arxiv"],
    ...(published === undefined ? {} : { date: published }),
    ...(venue === undefined ? {} : { venue }),
    ...(summary === undefined ? {} : { abstract: summary }),
    urls: {
      ...(abs === undefined ? {} : { landing: abs, abs }),
      ...(pdfUrl === undefined ? {} : { pdfUrl }),
    },
    openAccess: {
      isOa: true,
      ...(abs === undefined ? {} : { oaUrl: abs }),
    },
  });
  return paper;
}

function authorsFrom(value: unknown): { name: string }[] {
  const authors: { name: string }[] = [];
  for (const author of asArray(value)) {
    const record = asRecord(author);
    const name = clean(textContent(record?.["name"]) ?? asString(record?.["name"]) ?? asString(author));
    if (name !== undefined) authors.push({ name });
  }
  return authors;
}

function absUrl(record: Record<string, unknown>, arxivId: string | undefined): string | undefined {
  for (const link of asArray(record["link"])) {
    const href = attr(link, "href");
    const rel = attr(link, "rel");
    const type = attr(link, "type");
    if (href === undefined) continue;
    if (rel === "alternate" || type === "text/html") return href;
  }
  if (arxivId === undefined) return undefined;
  return `https://arxiv.org/abs/${arxivId}`;
}

function pdfLink(record: Record<string, unknown>): string | undefined {
  for (const link of asArray(record["link"])) {
    const href = attr(link, "href");
    const title = attr(link, "title");
    const type = attr(link, "type");
    if (href === undefined) continue;
    if (title === "pdf" || type === "application/pdf") return href;
  }
  return undefined;
}

function arxivQuery(request: SearchRequest): string {
  const raw = request.query.trim();
  const structured = /^(?:all|ti|au|abs|co|jr|cat|id):/i.test(raw) || /\s(?:AND|OR|ANDNOT)\s/.test(raw);
  const parts = [structured ? raw : `all:${raw}`];
  if (request.arxivCategory !== undefined) parts.push(`cat:${request.arxivCategory}`);
  if (request.yearFrom !== undefined || request.yearTo !== undefined) {
    const from = `${request.yearFrom ?? 1900}01010000`;
    const to = `${request.yearTo ?? 2100}12312359`;
    parts.push(`submittedDate:[${from} TO ${to}]`);
  }
  return parts.join(" AND ");
}

function clean(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const cleaned = value.replace(/\s+/g, " ").trim();
  return cleaned.length > 0 ? cleaned : undefined;
}
