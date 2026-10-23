import { z } from "zod";
import type { SearchRequest, SourceContext } from "../context.js";
import { FULL_TEXT_CAP } from "../context.js";
import { ConnectorError } from "../errors.js";
import {
  COPYRIGHT_ABSTRACT_NOTE,
  isOpenLicence,
  makePaper,
  normalizeDoi,
  normalizeOrcid,
  normalizePmcid,
  normalizePmid,
  type Author,
  type Paper,
  type Pmcid,
} from "../paper.js";
import { asArray, asNumber, asRecord, asString, parseJson, withQuery } from "../values.js";
import { xmlToPlainText } from "../xml.js";

const searchSchema = z.object({
  resultList: z
    .object({
      result: z.unknown().optional(),
    })
    .optional(),
});

const resultSchema = z.object({
  id: z.union([z.string(), z.number()]).optional(),
  source: z.string().optional(),
  doi: z.string().optional(),
  pmid: z.union([z.string(), z.number()]).optional(),
  pmcid: z.string().optional(),
  title: z.string().optional(),
  authorString: z.string().optional(),
  authorList: z.unknown().optional(),
  pubYear: z.union([z.string(), z.number()]).optional(),
  journalInfo: z.unknown().optional(),
  abstractText: z.string().optional(),
  isOpenAccess: z.union([z.string(), z.boolean()]).optional(),
  license: z.string().optional(),
  citedByCount: z.union([z.string(), z.number()]).optional(),
  fullTextUrlList: z.unknown().optional(),
});

export interface EuropePmcRecord {
  paper: Paper;
  pmcid?: Pmcid;
  pmid?: string;
  license?: string;
  isOpenAccess: boolean;
}

export async function searchEuropePmc(ctx: SourceContext, request: SearchRequest): Promise<Paper[]> {
  const records = await searchRecords(ctx, europeQuery(request), request.limit);
  return records.map((record) => record.paper);
}

export async function findEuropePmc(
  ctx: SourceContext,
  query: string,
): Promise<EuropePmcRecord | undefined> {
  const records = await searchRecords(ctx, query, 1);
  return records[0];
}

export async function europePmcCitations(
  ctx: SourceContext,
  kind: "MED" | "PMC",
  id: string,
  page: number,
  limit: number,
): Promise<Paper[]> {
  const url = withQuery(
    `https://www.ebi.ac.uk/europepmc/webservices/rest/${kind}/${encodeURIComponent(id)}/citations`,
    { format: "json", page, pageSize: limit },
  );
  return relatedPapers(await fetchJson(ctx, url), "citationList", "citation");
}

export async function europePmcReferences(
  ctx: SourceContext,
  kind: "MED" | "PMC",
  id: string,
  page: number,
  limit: number,
): Promise<Paper[]> {
  const url = withQuery(
    `https://www.ebi.ac.uk/europepmc/webservices/rest/${kind}/${encodeURIComponent(id)}/references`,
    { format: "json", page, pageSize: limit },
  );
  return relatedPapers(await fetchJson(ctx, url), "referenceList", "reference");
}

export async function europePmcFullText(
  ctx: SourceContext,
  pmcid: Pmcid,
): Promise<{ text: string; truncated: boolean }> {
  const url = `https://www.ebi.ac.uk/europepmc/webservices/rest/${pmcid}/fullTextXML`;
  const response = await ctx.upstream.getText({
    source: "europepmc",
    url,
    accept: "application/xml",
    scheduler: ctx.schedulers.europepmc,
    cacheTtlSec: ctx.config.cacheTtlSec,
  });
  return xmlToPlainText(response.text, FULL_TEXT_CAP);
}

async function searchRecords(
  ctx: SourceContext,
  query: string,
  limit: number,
): Promise<EuropePmcRecord[]> {
  const url = withQuery("https://www.ebi.ac.uk/europepmc/webservices/rest/search", {
    query,
    format: "json",
    pageSize: limit,
    resultType: "core",
  });
  const payload = await fetchJson(ctx, url);
  const parsed = searchSchema.safeParse(payload);
  if (!parsed.success) {
    throw new ConnectorError(
      "upstream_unavailable",
      "europepmc response did not match the expected shape.",
    );
  }
  const records: EuropePmcRecord[] = [];
  for (const item of asArray(parsed.data.resultList?.result)) {
    const record = recordFromResult(item);
    if (record !== undefined) records.push(record);
  }
  return records;
}

async function fetchJson(ctx: SourceContext, url: string): Promise<unknown> {
  const response = await ctx.upstream.getText({
    source: "europepmc",
    url,
    accept: "application/json",
    scheduler: ctx.schedulers.europepmc,
    cacheTtlSec: ctx.config.cacheTtlSec,
  });
  return parseJson(response.text, "europepmc");
}

export function recordFromResult(value: unknown): EuropePmcRecord | undefined {
  const parsed = resultSchema.safeParse(value);
  if (!parsed.success) return undefined;
  const result = parsed.data;
  const title = result.title?.replace(/\s+/g, " ").trim();
  if (title === undefined || title.length === 0) return undefined;
  const doi = normalizeDoi(result.doi);
  const pmid = normalizePmid(asString(result.pmid) ?? asString(result.id));
  const pmcid = normalizePmcid(result.pmcid);
  const year = asNumber(result.pubYear);
  const isOpenAccess = result.isOpenAccess === true || result.isOpenAccess === "Y";
  const license = result.license;
  const links = fullTextLinks(result.fullTextUrlList);
  const landing = links.html ?? (doi === undefined ? undefined : `https://doi.org/${doi}`);
  const pdfUrl = links.pdf;
  const abstract = result.abstractText?.replace(/\s+/g, " ").trim();
  const openLicence = isOpenLicence(license);
  const citationCount = asNumber(result.citedByCount);
  const oaUrl = isOpenAccess ? (links.oa ?? pdfUrl ?? landing) : undefined;
  const venue = journalTitle(result.journalInfo);
  const paper = makePaper({
    ids: {
      ...(doi === undefined ? {} : { doi }),
      ...(pmid === undefined ? {} : { pmid }),
      ...(pmcid === undefined ? {} : { pmcid }),
    },
    title,
    authors: authorsFrom(result.authorList, result.authorString),
    sources: ["europepmc"],
    ...(year === undefined ? {} : { year }),
    ...(venue === undefined ? {} : { venue }),
    ...(abstract === undefined
      ? {}
      : {
          abstract,
          ...(openLicence ? {} : { abstractNote: COPYRIGHT_ABSTRACT_NOTE }),
        }),
    urls: {
      ...(landing === undefined ? {} : { landing }),
      ...(pdfUrl === undefined ? {} : { pdfUrl }),
    },
    openAccess: {
      isOa: isOpenAccess,
      ...(oaUrl === undefined ? {} : { oaUrl }),
      ...(license === undefined ? {} : { license }),
    },
    ...(citationCount === undefined ? {} : { citationCount }),
  });
  if (paper === undefined) return undefined;
  const record: EuropePmcRecord = { paper, isOpenAccess };
  if (pmcid !== undefined) record.pmcid = pmcid;
  if (pmid !== undefined) record.pmid = pmid;
  if (license !== undefined) record.license = license;
  return record;
}

function relatedPapers(payload: unknown, listKey: string, itemKey: string): Paper[] {
  const record = asRecord(payload);
  const items = asArray(asRecord(record?.[listKey])?.[itemKey]);
  const papers: Paper[] = [];
  for (const item of items) {
    const related = asRecord(item);
    const title = asString(related?.["title"]) ?? asString(related?.["citationText"]);
    if (title === undefined) continue;
    const doi = normalizeDoi(asString(related?.["doi"]));
    const year = asNumber(related?.["pubYear"]);
    const authorString = asString(related?.["authorString"]);
    const pmid = normalizePmid(asString(related?.["id"]));
    const venue = asString(related?.["journalAbbreviation"]);
    const paper = makePaper({
      ids: {
        ...(doi === undefined ? {} : { doi }),
        ...(pmid === undefined ? {} : { pmid }),
      },
      title,
      authors:
        authorString === undefined
          ? []
          : authorString.split(",").map((name) => ({ name: name.trim() })).filter((author) => author.name.length > 0),
      sources: ["europepmc"],
      ...(year === undefined ? {} : { year }),
      ...(venue === undefined ? {} : { venue }),
      urls: doi === undefined ? {} : { landing: `https://doi.org/${doi}` },
      openAccess: { isOa: false },
    });
    if (paper !== undefined) papers.push(paper);
  }
  return papers;
}

function authorsFrom(authorList: unknown, authorString: string | undefined): Author[] {
  const authors: Author[] = [];
  const list = asRecord(authorList);
  for (const item of asArray(list?.["author"])) {
    const record = asRecord(item);
    const name = asString(record?.["fullName"]);
    if (name === undefined) continue;
    const author: Author = { name };
    const authorId = asRecord(record?.["authorId"]);
    const orcid =
      asString(authorId?.["type"])?.toUpperCase() === "ORCID"
        ? normalizeOrcid(asString(authorId?.["value"]))
        : undefined;
    if (orcid !== undefined) author.orcid = orcid;
    authors.push(author);
  }
  if (authors.length > 0) return authors;
  if (authorString === undefined) return [];
  return authorString
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0)
    .map((name) => ({ name }));
}

function journalTitle(value: unknown): string | undefined {
  return asString(asRecord(asRecord(value)?.["journal"])?.["title"]);
}

function fullTextLinks(value: unknown): { html?: string; pdf?: string; oa?: string } {
  const links: { html?: string; pdf?: string; oa?: string } = {};
  for (const item of asArray(asRecord(value)?.["fullTextUrl"])) {
    const record = asRecord(item);
    const url = asString(record?.["url"]);
    if (url === undefined) continue;
    const style = asString(record?.["documentStyle"])?.toLowerCase();
    if (style === "pdf" && links.pdf === undefined) links.pdf = url;
    if (style === "html" && links.html === undefined) links.html = url;
    if (links.oa === undefined) links.oa = url;
  }
  return links;
}

function europeQuery(request: SearchRequest): string {
  const parts = [`(${request.query})`];
  if (request.openAccessOnly) parts.push("OPEN_ACCESS:Y");
  if (request.yearFrom !== undefined || request.yearTo !== undefined) {
    parts.push(`PUB_YEAR:[${request.yearFrom ?? 1900} TO ${request.yearTo ?? 2100}]`);
  }
  return parts.join(" AND ");
}
