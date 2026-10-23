import { z } from "zod";
import type { SearchRequest, SourceContext } from "../context.js";
import { ConnectorError } from "../errors.js";
import {
  makePaper,
  normalizeDoi,
  normalizeOpenAlexId,
  normalizeOrcid,
  normalizePmcid,
  normalizePmid,
  type Author,
  type Doi,
  type OpenAlexId,
  type Paper,
} from "../paper.js";
import { bearer } from "../upstream.js";
import { asArray, asNumber, asRecord, asString, parseJson, withQuery } from "../values.js";

const listSchema = z.object({
  results: z.array(z.unknown()).optional(),
  meta: z.unknown().optional(),
});

const workSchema = z.object({
  id: z.string().optional(),
  doi: z.string().optional(),
  display_name: z.string().optional(),
  publication_year: z.number().optional(),
  publication_date: z.string().optional(),
  cited_by_count: z.number().optional(),
  authorships: z.unknown().optional(),
  primary_location: z.unknown().optional(),
  best_oa_location: z.unknown().optional(),
  open_access: z.unknown().optional(),
  ids: z.unknown().optional(),
  abstract_inverted_index: z.unknown().optional(),
  referenced_works: z.array(z.string()).optional(),
});

const authorSchema = z.object({
  id: z.string().optional(),
  display_name: z.string().optional(),
  orcid: z.string().optional(),
  works_count: z.number().optional(),
  summary_stats: z.unknown().optional(),
  affiliations: z.unknown().optional(),
  last_known_institutions: z.unknown().optional(),
});

export interface AuthorHit {
  openalexId: OpenAlexId;
  name: string;
  orcid?: string;
  affiliations: string[];
  worksCount?: number;
  hIndex?: number;
}

const SELECT =
  "id,doi,display_name,publication_year,publication_date,cited_by_count,authorships,primary_location,best_oa_location,open_access,ids,abstract_inverted_index";

export async function searchOpenAlex(ctx: SourceContext, request: SearchRequest): Promise<Paper[]> {
  const filter = openAlexFilter(request);
  const url = withQuery("https://api.openalex.org/works", {
    search: request.query,
    per_page: request.limit,
    select: SELECT,
    filter,
    mailto: ctx.config.contactEmail,
  });
  return worksFromPayload(await fetchJson(ctx, url));
}

export async function getOpenAlexWork(ctx: SourceContext, rawId: string): Promise<Paper> {
  const id = normalizeOpenAlexId(rawId, "W");
  if (id === undefined) {
    throw new ConnectorError("invalid_input", "openalex id must look like W123.");
  }
  const papers = worksFromPayload(await fetchJson(ctx, workUrl(ctx, id)));
  const paper = papers[0];
  if (paper === undefined) throw new ConnectorError("not_found", `openalex has no record for ${id}.`);
  return paper;
}

export async function getOpenAlexByDoi(ctx: SourceContext, doi: Doi): Promise<Paper> {
  const papers = worksFromPayload(
    await fetchJson(ctx, workUrl(ctx, `doi:${encodeURIComponent(doi)}`)),
  );
  const paper = papers[0];
  if (paper === undefined) throw new ConnectorError("not_found", `openalex has no record for ${doi}.`);
  return paper;
}

export async function openAlexCitations(
  ctx: SourceContext,
  openalexId: OpenAlexId,
  page: number,
  limit: number,
): Promise<Paper[]> {
  const url = withQuery("https://api.openalex.org/works", {
    filter: `cites:${openalexId}`,
    page,
    per_page: limit,
    select: SELECT,
    mailto: ctx.config.contactEmail,
  });
  return worksFromPayload(await fetchJson(ctx, url));
}

export async function openAlexReferences(
  ctx: SourceContext,
  openalexId: OpenAlexId,
  page: number,
  limit: number,
): Promise<Paper[]> {
  const work = await fetchJson(ctx, workUrl(ctx, openalexId, "id,referenced_works"));
  const parsed = workSchema.safeParse(singleOrFirst(work));
  if (!parsed.success) {
    throw new ConnectorError("upstream_unavailable", "openalex work did not match the expected shape.");
  }
  const ids = parsed.data.referenced_works ?? [];
  const start = (page - 1) * limit;
  const slice = ids.slice(start, start + limit);
  if (slice.length === 0) return [];
  const short = slice
    .map((value) => normalizeOpenAlexId(value, "W"))
    .filter((value): value is OpenAlexId => value !== undefined);
  if (short.length === 0) return [];
  const url = withQuery("https://api.openalex.org/works", {
    filter: `openalex:${short.join("|")}`,
    per_page: short.length,
    select: SELECT,
    mailto: ctx.config.contactEmail,
  });
  return worksFromPayload(await fetchJson(ctx, url));
}

export async function searchOpenAlexAuthors(
  ctx: SourceContext,
  query: string,
  limit: number,
): Promise<AuthorHit[]> {
  const url = withQuery("https://api.openalex.org/authors", {
    search: query,
    per_page: limit,
    mailto: ctx.config.contactEmail,
  });
  return authorsFromPayload(await fetchJson(ctx, url));
}

export async function openAlexAuthorWorks(
  ctx: SourceContext,
  rawId: string,
  page: number,
  limit: number,
): Promise<Paper[]> {
  const id = normalizeOpenAlexId(rawId, "A");
  if (id === undefined) {
    throw new ConnectorError("invalid_input", "openalex author id must look like A123.");
  }
  const url = withQuery("https://api.openalex.org/works", {
    filter: `authorships.author.id:${id}`,
    page,
    per_page: limit,
    select: SELECT,
    mailto: ctx.config.contactEmail,
  });
  return worksFromPayload(await fetchJson(ctx, url));
}

export async function resolveOpenAlexId(ctx: SourceContext, doi: Doi): Promise<OpenAlexId> {
  const paper = await getOpenAlexByDoi(ctx, doi);
  const id = paper.ids.openalexId;
  if (id === undefined) {
    throw new ConnectorError("not_found", `openalex has no work id for ${doi}.`);
  }
  return id;
}

async function fetchJson(ctx: SourceContext, url: string): Promise<unknown> {
  const headers = bearer(ctx.config.openAlexApiKey);
  const response = await ctx.upstream.getText({
    source: "openalex",
    url,
    accept: "application/json",
    scheduler: ctx.schedulers.openalex,
    cacheTtlSec: ctx.config.cacheTtlSec,
    ...(headers === undefined ? {} : { headers }),
  });
  return parseJson(response.text, "openalex");
}

function workUrl(ctx: SourceContext, id: string, select = SELECT): string {
  return withQuery(`https://api.openalex.org/works/${id}`, {
    select,
    mailto: ctx.config.contactEmail,
  });
}

export function worksFromPayload(payload: unknown): Paper[] {
  const papers: Paper[] = [];
  for (const item of workItems(payload)) {
    const paper = paperFromWork(item);
    if (paper !== undefined) papers.push(paper);
  }
  return papers;
}

function workItems(payload: unknown): unknown[] {
  const list = listSchema.safeParse(payload);
  if (list.success && list.data.results !== undefined) return list.data.results;
  const single = workSchema.safeParse(payload);
  if (single.success && (single.data.id !== undefined || single.data.display_name !== undefined)) {
    return [payload];
  }
  throw new ConnectorError("upstream_unavailable", "openalex response did not match the expected shape.");
}

function singleOrFirst(payload: unknown): unknown {
  const items = workItems(payload);
  return items[0];
}

function paperFromWork(value: unknown): Paper | undefined {
  const parsed = workSchema.safeParse(value);
  if (!parsed.success) return undefined;
  const work = parsed.data;
  const title = work.display_name?.replace(/\s+/g, " ").trim();
  if (title === undefined || title.length === 0) return undefined;
  const ids = asRecord(work.ids);
  const openalexId = normalizeOpenAlexId(work.id ?? asString(ids?.["openalex"]), "W");
  const doi = normalizeDoi(work.doi ?? asString(ids?.["doi"]));
  const pmid = normalizePmid(asString(ids?.["pmid"]));
  const pmcid = normalizePmcid(asString(ids?.["pmcid"]));
  const location = asRecord(work.best_oa_location) ?? asRecord(work.primary_location);
  const primary = asRecord(work.primary_location);
  const access = asRecord(work.open_access);
  const source = asRecord(location?.["source"]) ?? asRecord(primary?.["source"]);
  const landing = asString(primary?.["landing_page_url"]) ?? asString(location?.["landing_page_url"]);
  const pdfUrl = asString(location?.["pdf_url"]);
  const oaUrl = asString(access?.["oa_url"]) ?? pdfUrl ?? (access?.["is_oa"] === true ? landing : undefined);
  const license = asString(location?.["license"]);
  const hostType = asString(source?.["type"]);
  const isOa = access?.["is_oa"] === true || location?.["is_oa"] === true;
  const abstract = abstractFromIndex(work.abstract_inverted_index);
  const venue = asString(source?.["display_name"]);
  return makePaper({
    ids: {
      ...(openalexId === undefined ? {} : { openalexId }),
      ...(doi === undefined ? {} : { doi }),
      ...(pmid === undefined ? {} : { pmid }),
      ...(pmcid === undefined ? {} : { pmcid }),
    },
    title,
    authors: authorsFrom(work.authorships),
    sources: ["openalex"],
    ...(work.publication_year === undefined ? {} : { year: work.publication_year }),
    ...(work.publication_date === undefined ? {} : { date: work.publication_date }),
    ...(venue === undefined ? {} : { venue }),
    ...(abstract === undefined ? {} : { abstract }),
    urls: {
      ...(landing === undefined ? {} : { landing }),
      ...(pdfUrl === undefined ? {} : { pdfUrl }),
    },
    openAccess: {
      isOa,
      ...(oaUrl === undefined ? {} : { oaUrl }),
      ...(license === undefined ? {} : { license }),
      ...(hostType === undefined ? {} : { hostType }),
    },
    ...(work.cited_by_count === undefined ? {} : { citationCount: work.cited_by_count }),
  });
}

function authorsFrom(value: unknown): Author[] {
  const authors: Author[] = [];
  for (const item of asArray(value)) {
    const record = asRecord(item);
    const author = asRecord(record?.["author"]);
    const name = asString(author?.["display_name"]);
    if (name === undefined) continue;
    const next: Author = { name };
    const orcid = normalizeOrcid(asString(author?.["orcid"]));
    if (orcid !== undefined) next.orcid = orcid;
    authors.push(next);
  }
  return authors;
}

export function abstractFromIndex(value: unknown): string | undefined {
  const record = asRecord(value);
  if (record === undefined) return undefined;
  const placed: { pos: number; word: string }[] = [];
  for (const [word, positions] of Object.entries(record)) {
    if (!Array.isArray(positions)) continue;
    for (const position of positions) {
      if (typeof position === "number" && Number.isInteger(position)) {
        placed.push({ pos: position, word });
      }
    }
  }
  if (placed.length === 0) return undefined;
  placed.sort((left, right) => left.pos - right.pos);
  return placed.map((item) => item.word).join(" ");
}

function authorsFromPayload(payload: unknown): AuthorHit[] {
  const list = listSchema.safeParse(payload);
  if (!list.success) {
    throw new ConnectorError("upstream_unavailable", "openalex author response did not match the expected shape.");
  }
  const hits: AuthorHit[] = [];
  for (const item of list.data.results ?? []) {
    const parsed = authorSchema.safeParse(item);
    if (!parsed.success) continue;
    const id = normalizeOpenAlexId(parsed.data.id, "A");
    const name = parsed.data.display_name;
    if (id === undefined || name === undefined) continue;
    const hit: AuthorHit = { openalexId: id, name, affiliations: affiliationsFrom(parsed.data) };
    const orcid = normalizeOrcid(parsed.data.orcid);
    if (orcid !== undefined) hit.orcid = orcid;
    if (parsed.data.works_count !== undefined) hit.worksCount = parsed.data.works_count;
    const hIndex = asNumber(asRecord(parsed.data.summary_stats)?.["h_index"]);
    if (hIndex !== undefined) hit.hIndex = hIndex;
    hits.push(hit);
  }
  return hits;
}

function affiliationsFrom(author: z.infer<typeof authorSchema>): string[] {
  const names: string[] = [];
  for (const item of asArray(author.affiliations)) {
    const name = asString(asRecord(asRecord(item)?.["institution"])?.["display_name"]);
    if (name !== undefined && !names.includes(name)) names.push(name);
  }
  for (const item of asArray(author.last_known_institutions)) {
    const name = asString(asRecord(item)?.["display_name"]);
    if (name !== undefined && !names.includes(name)) names.push(name);
  }
  return names;
}

function openAlexFilter(request: SearchRequest): string | undefined {
  const parts: string[] = [];
  if (request.yearFrom !== undefined) parts.push(`from_publication_date:${request.yearFrom}-01-01`);
  if (request.yearTo !== undefined) parts.push(`to_publication_date:${request.yearTo}-12-31`);
  if (request.openAccessOnly) parts.push("is_oa:true");
  return parts.length > 0 ? parts.join(",") : undefined;
}

export function authorRecord(hit: AuthorHit): Record<string, unknown> {
  return {
    openalexId: hit.openalexId,
    name: hit.name,
    ...(hit.orcid === undefined ? {} : { orcid: hit.orcid }),
    affiliations: hit.affiliations,
    ...(hit.worksCount === undefined ? {} : { worksCount: hit.worksCount }),
    ...(hit.hIndex === undefined ? {} : { hIndex: hit.hIndex }),
  };
}
