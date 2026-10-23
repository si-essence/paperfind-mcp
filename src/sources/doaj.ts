import { z } from "zod";
import type { SearchRequest, SourceContext } from "../context.js";
import { ConnectorError } from "../errors.js";
import { makePaper, normalizeDoi, normalizeDoajId, normalizeOrcid, type Author, type Paper } from "../paper.js";
import { asArray, asNumber, asRecord, asString, parseJson, withQuery } from "../values.js";

const payloadSchema = z.object({
  results: z.array(z.unknown()).optional(),
});

const articleSchema = z.object({
  id: z.string().optional(),
  bibjson: z.unknown().optional(),
});

export async function searchDoaj(ctx: SourceContext, request: SearchRequest): Promise<Paper[]> {
  const query = doajQuery(request);
  const url = withQuery(`https://doaj.org/api/v4/search/articles/${encodeURIComponent(query)}`, {
    page: 1,
    pageSize: request.limit,
  });
  const response = await ctx.upstream.getText({
    source: "doaj",
    url,
    accept: "application/json",
    scheduler: ctx.schedulers.doaj,
    cacheTtlSec: ctx.config.cacheTtlSec,
  });
  return papersFromPayload(parseJson(response.text, "doaj"));
}

export function papersFromPayload(payload: unknown): Paper[] {
  const parsed = payloadSchema.safeParse(payload);
  if (!parsed.success) {
    throw new ConnectorError("upstream_unavailable", "doaj response did not match the expected shape.");
  }
  const papers: Paper[] = [];
  for (const item of parsed.data.results ?? []) {
    const paper = paperFromArticle(item);
    if (paper !== undefined) papers.push(paper);
  }
  return papers;
}

function paperFromArticle(value: unknown): Paper | undefined {
  const parsed = articleSchema.safeParse(value);
  if (!parsed.success) return undefined;
  const bib = asRecord(parsed.data.bibjson);
  const title = asString(bib?.["title"]);
  if (title === undefined) return undefined;
  const doajId = normalizeDoajId(parsed.data.id);
  const doi = normalizeDoi(identifier(bib?.["identifier"], "doi"));
  const year = asNumber(bib?.["year"]);
  const links = linksFrom(bib?.["link"]);
  const license = firstLicense(bib?.["license"]);
  const abstract = asString(bib?.["abstract"]);
  const oaUrl = links.pdf ?? links.landing;
  const venue = asString(asRecord(bib?.["journal"])?.["title"]);
  return makePaper({
    ids: {
      ...(doajId === undefined ? {} : { doajId }),
      ...(doi === undefined ? {} : { doi }),
    },
    title,
    authors: authorsFrom(bib?.["author"]),
    sources: ["doaj"],
    ...(year === undefined ? {} : { year }),
    ...(venue === undefined ? {} : { venue }),
    ...(abstract === undefined ? {} : { abstract }),
    urls: {
      ...(links.landing === undefined ? {} : { landing: links.landing }),
      ...(links.pdf === undefined ? {} : { pdfUrl: links.pdf }),
    },
    openAccess: {
      isOa: true,
      ...(oaUrl === undefined ? {} : { oaUrl }),
      ...(license === undefined ? {} : { license }),
    },
  });
}

function authorsFrom(value: unknown): Author[] {
  const authors: Author[] = [];
  for (const item of asArray(value)) {
    const record = asRecord(item);
    const name = asString(record?.["name"]);
    if (name === undefined) continue;
    const author: Author = { name };
    const orcid = normalizeOrcid(asString(record?.["orcid"]));
    if (orcid !== undefined) author.orcid = orcid;
    authors.push(author);
  }
  return authors;
}

function identifier(value: unknown, type: string): string | undefined {
  for (const item of asArray(value)) {
    const record = asRecord(item);
    if (asString(record?.["type"])?.toLowerCase() === type) return asString(record?.["id"]);
  }
  return undefined;
}

function linksFrom(value: unknown): { landing?: string; pdf?: string } {
  const links: { landing?: string; pdf?: string } = {};
  for (const item of asArray(value)) {
    const record = asRecord(item);
    const url = asString(record?.["url"]);
    if (url === undefined) continue;
    const type = asString(record?.["type"])?.toLowerCase();
    if (type === "fulltext" && links.landing === undefined) links.landing = url;
    if ((type === "pdf" || url.toLowerCase().includes(".pdf")) && links.pdf === undefined) links.pdf = url;
  }
  if (links.landing === undefined) {
    for (const item of asArray(value)) {
      const url = asString(asRecord(item)?.["url"]);
      if (url !== undefined) {
        links.landing = url;
        break;
      }
    }
  }
  return links;
}

function firstLicense(value: unknown): string | undefined {
  for (const item of asArray(value)) {
    const record = asRecord(item);
    const url = asString(record?.["url"]) ?? asString(record?.["type"]);
    if (url !== undefined) return url;
  }
  return asString(value);
}

function doajQuery(request: SearchRequest): string {
  const parts = [request.query];
  if (request.yearFrom !== undefined && request.yearFrom === request.yearTo) {
    parts.push(`year:${request.yearFrom}`);
  }
  return parts.join(" AND ");
}
