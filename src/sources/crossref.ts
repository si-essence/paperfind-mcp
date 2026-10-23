import { z } from "zod";
import type { SearchRequest, SourceContext } from "../context.js";
import { ConnectorError } from "../errors.js";
import {
  COPYRIGHT_ABSTRACT_NOTE,
  makePaper,
  normalizeDoi,
  normalizeOrcid,
  type Author,
  type Doi,
  type Paper,
} from "../paper.js";
import { asArray, asNumber, asRecord, asString, parseJson, withQuery } from "../values.js";
import { decodeEntities } from "../xml.js";

const envelopeSchema = z.object({
  status: z.string().optional(),
  message: z.unknown(),
});

const workSchema = z.object({
  DOI: z.string().optional(),
  title: z.union([z.string(), z.array(z.string())]).optional(),
  author: z.unknown().optional(),
  issued: z.unknown().optional(),
  "container-title": z.union([z.string(), z.array(z.string())]).optional(),
  abstract: z.string().optional(),
  URL: z.string().optional(),
  "is-referenced-by-count": z.number().optional(),
  link: z.unknown().optional(),
  license: z.unknown().optional(),
  reference: z.unknown().optional(),
});

export async function searchCrossref(ctx: SourceContext, request: SearchRequest): Promise<Paper[]> {
  const url = withQuery("https://api.crossref.org/works", {
    query: request.query,
    rows: request.limit,
    mailto: ctx.config.contactEmail,
    filter: crossrefFilter(request),
    select: "DOI,title,author,issued,container-title,abstract,URL,is-referenced-by-count,link,license",
  });
  return worksFromPayload(await fetchJson(ctx, url));
}

export async function getCrossrefByDoi(ctx: SourceContext, doi: Doi): Promise<Paper> {
  const url = withQuery(`https://api.crossref.org/works/${encodeURIComponent(doi)}`, {
    mailto: ctx.config.contactEmail,
  });
  const papers = worksFromPayload(await fetchJson(ctx, url));
  const paper = papers[0];
  if (paper === undefined) {
    throw new ConnectorError("not_found", `crossref has no record for ${doi}.`);
  }
  return paper;
}

export async function crossrefReferences(
  ctx: SourceContext,
  doi: Doi,
  page: number,
  limit: number,
): Promise<Paper[]> {
  const paperUrl = withQuery(`https://api.crossref.org/works/${encodeURIComponent(doi)}`, {
    mailto: ctx.config.contactEmail,
    select: "DOI,reference",
  });
  const payload = await fetchJson(ctx, paperUrl);
  const works = readWorks(payload);
  const parsed = works[0] === undefined ? undefined : workSchema.safeParse(works[0]);
  const references = parsed?.success === true ? asArray(parsed.data.reference) : [];
  const start = (page - 1) * limit;
  const slice = references.slice(start, start + limit);
  const papers: Paper[] = [];
  for (const reference of slice) {
    const paper = paperFromReference(reference);
    if (paper !== undefined) papers.push(paper);
  }
  return papers;
}

async function fetchJson(ctx: SourceContext, url: string): Promise<unknown> {
  const response = await ctx.upstream.getText({
    source: "crossref",
    url,
    accept: "application/json",
    scheduler: ctx.schedulers.crossref,
    cacheTtlSec: ctx.config.cacheTtlSec,
  });
  return parseJson(response.text, "crossref");
}

export function worksFromPayload(payload: unknown): Paper[] {
  const works = readWorks(payload);
  const papers: Paper[] = [];
  for (const work of works) {
    const paper = paperFromWork(work);
    if (paper !== undefined) papers.push(paper);
  }
  return papers;
}

function readWorks(payload: unknown): unknown[] {
  const envelope = envelopeSchema.safeParse(payload);
  if (!envelope.success) {
    throw new ConnectorError("upstream_unavailable", "crossref response did not match the expected shape.");
  }
  if (envelope.data.status !== undefined && envelope.data.status !== "ok") {
    throw new ConnectorError("upstream_unavailable", `crossref status ${envelope.data.status}.`);
  }
  const message = asRecord(envelope.data.message);
  if (message === undefined) return [];
  if (Array.isArray(message["items"])) return message["items"];
  if (asString(message["DOI"]) !== undefined || message["title"] !== undefined) return [message];
  return [];
}

function paperFromWork(value: unknown): Paper | undefined {
  const parsed = workSchema.safeParse(value);
  if (!parsed.success) return undefined;
  const work = parsed.data;
  const title = firstString(work.title);
  if (title === undefined) return undefined;
  const doi = normalizeDoi(work.DOI);
  const abstract = work.abstract === undefined ? undefined : stripTags(work.abstract);
  const license = firstLicense(work.license);
  const pdfUrl = firstPdf(work.link);
  const landing = work.URL;
  const year = yearFromIssued(work.issued);
  const venue = firstString(work["container-title"]);
  return makePaper({
    ids: doi === undefined ? {} : { doi },
    title,
    authors: authorsFrom(work.author),
    sources: ["crossref"],
    ...(year === undefined ? {} : { year }),
    ...(venue === undefined ? {} : { venue }),
    ...(abstract === undefined ? {} : { abstract, abstractNote: COPYRIGHT_ABSTRACT_NOTE }),
    urls: {
      ...(landing === undefined ? {} : { landing }),
      ...(pdfUrl === undefined ? {} : { pdfUrl }),
    },
    openAccess: {
      isOa: license !== undefined && /creativecommons\.org|^cc[-\s]/i.test(license),
      ...(license === undefined ? {} : { license }),
      ...(pdfUrl === undefined ? {} : { oaUrl: pdfUrl }),
    },
    ...(work["is-referenced-by-count"] === undefined
      ? {}
      : { citationCount: work["is-referenced-by-count"] }),
  });
}

function paperFromReference(value: unknown): Paper | undefined {
  const record = asRecord(value);
  if (record === undefined) return undefined;
  const title = asString(record["article-title"]) ?? asString(record["unstructured"]);
  if (title === undefined) return undefined;
  const doi = normalizeDoi(asString(record["DOI"]));
  const year = asNumber(record["year"]);
  const author = asString(record["author"]);
  const venue = asString(record["journal-title"]);
  return makePaper({
    ids: doi === undefined ? {} : { doi },
    title,
    authors: author === undefined ? [] : [{ name: author }],
    sources: ["crossref"],
    ...(year === undefined ? {} : { year }),
    ...(venue === undefined ? {} : { venue }),
    urls: doi === undefined ? {} : { landing: `https://doi.org/${doi}` },
    openAccess: { isOa: false },
  });
}

function authorsFrom(value: unknown): Author[] {
  const authors: Author[] = [];
  for (const item of asArray(value)) {
    const record = asRecord(item);
    if (record === undefined) continue;
    const name = joinName(asString(record["given"]), asString(record["family"]), asString(record["name"]));
    if (name === undefined) continue;
    const author: Author = { name };
    const orcid = normalizeOrcid(asString(record["ORCID"]));
    if (orcid !== undefined) author.orcid = orcid;
    authors.push(author);
  }
  return authors;
}

function joinName(
  given: string | undefined,
  family: string | undefined,
  name: string | undefined,
): string | undefined {
  if (name !== undefined) return name;
  const full = [given, family].filter((part) => part !== undefined).join(" ").trim();
  return full.length > 0 ? full : undefined;
}

function firstString(value: string | string[] | undefined): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.replace(/\s+/g, " ").trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (value === undefined) return undefined;
  for (const item of value) {
    const trimmed = item.replace(/\s+/g, " ").trim();
    if (trimmed.length > 0) return trimmed;
  }
  return undefined;
}

function yearFromIssued(value: unknown): number | undefined {
  const record = asRecord(value);
  const parts = asArray(record?.["date-parts"]);
  const first = asArray(parts[0]);
  const year = asNumber(first[0]);
  if (year === undefined || year < 1500 || year > 2100) return undefined;
  return year;
}

function firstLicense(value: unknown): string | undefined {
  for (const item of asArray(value)) {
    const url = asString(asRecord(item)?.["URL"]);
    if (url !== undefined) return url;
  }
  return undefined;
}

function firstPdf(value: unknown): string | undefined {
  for (const item of asArray(value)) {
    const record = asRecord(item);
    const contentType = asString(record?.["content-type"]);
    const url = asString(record?.["URL"]);
    if (url !== undefined && contentType === "application/pdf") return url;
  }
  return undefined;
}

function crossrefFilter(request: SearchRequest): string | undefined {
  const parts: string[] = [];
  if (request.yearFrom !== undefined) parts.push(`from-pub-date:${request.yearFrom}-01-01`);
  if (request.yearTo !== undefined) parts.push(`until-pub-date:${request.yearTo}-12-31`);
  return parts.length > 0 ? parts.join(",") : undefined;
}

function stripTags(value: string): string {
  return decodeEntities(value.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}
