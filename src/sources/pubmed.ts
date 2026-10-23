import { z } from "zod";
import type { SearchRequest, SourceContext } from "../context.js";
import { ConnectorError } from "../errors.js";
import {
  COPYRIGHT_ABSTRACT_NOTE,
  makePaper,
  normalizeDoi,
  normalizeOrcid,
  normalizePmcid,
  normalizePmid,
  type Author,
  type Paper,
  type Pmid,
} from "../paper.js";
import { asArray, asRecord, asString, attr, parseJson, textContent, withQuery } from "../values.js";
import { parseXml } from "../xml.js";

const esearchSchema = z.object({
  esearchresult: z
    .object({
      idlist: z.array(z.string()).optional(),
      ERROR: z.string().optional(),
    })
    .optional(),
});

export async function searchPubmed(ctx: SourceContext, request: SearchRequest): Promise<Paper[]> {
  const ids = await esearch(ctx, pubmedTerm(request), request.limit);
  if (ids.length === 0) return [];
  const papers = await efetch(ctx, ids);
  if (!request.openAccessOnly) return papers;
  // NCBI already applied free full text[filter]. The XML does not carry an OA flag,
  // so the filter is the signal that these hits are free to read.
  return papers.map((paper) => ({
    ...paper,
    openAccess: { ...paper.openAccess, isOa: true },
  }));
}

export async function getPubmed(ctx: SourceContext, rawId: string): Promise<Paper> {
  const pmid = normalizePmid(rawId);
  if (pmid === undefined) {
    throw new ConnectorError("invalid_input", "pmid must be a PubMed id.");
  }
  const papers = await efetch(ctx, [pmid]);
  const paper = papers[0];
  if (paper === undefined) throw new ConnectorError("not_found", `pubmed has no record for ${pmid}.`);
  return paper;
}

async function esearch(ctx: SourceContext, term: string, limit: number): Promise<Pmid[]> {
  const url = withQuery("https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi", {
    db: "pubmed",
    term,
    retmode: "json",
    retmax: limit,
    ...ncbiIdentity(ctx),
  });
  const response = await ctx.upstream.getText({
    source: "pubmed",
    url,
    accept: "application/json",
    scheduler: ctx.schedulers.pubmed,
    cacheTtlSec: ctx.config.cacheTtlSec,
  });
  const parsed = esearchSchema.safeParse(parseJson(response.text, "pubmed"));
  if (!parsed.success) {
    throw new ConnectorError("upstream_unavailable", "pubmed esearch response did not match the expected shape.");
  }
  const error = parsed.data.esearchresult?.ERROR;
  if (error !== undefined) {
    throw new ConnectorError("upstream_unavailable", `pubmed rejected the query: ${error.slice(0, 180)}`);
  }
  const ids: Pmid[] = [];
  for (const id of parsed.data.esearchresult?.idlist ?? []) {
    const pmid = normalizePmid(id);
    if (pmid !== undefined) ids.push(pmid);
  }
  return ids;
}

async function efetch(ctx: SourceContext, ids: readonly Pmid[]): Promise<Paper[]> {
  const url = withQuery("https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi", {
    db: "pubmed",
    id: ids.join(","),
    retmode: "xml",
    ...ncbiIdentity(ctx),
  });
  const response = await ctx.upstream.getText({
    source: "pubmed",
    url,
    accept: "application/xml",
    scheduler: ctx.schedulers.pubmed,
    cacheTtlSec: ctx.config.cacheTtlSec,
  });
  return papersFromPubmedXml(response.text);
}

export function papersFromPubmedXml(xml: string): Paper[] {
  const root = asRecord(parseXml(xml));
  const set = asRecord(root?.["PubmedArticleSet"]) ?? root;
  const papers: Paper[] = [];
  for (const article of asArray(set?.["PubmedArticle"])) {
    const paper = paperFromArticle(article);
    if (paper !== undefined) papers.push(paper);
  }
  return papers;
}

function paperFromArticle(value: unknown): Paper | undefined {
  const article = asRecord(value);
  const citation = asRecord(article?.["MedlineCitation"]);
  const medline = asRecord(citation?.["Article"]);
  const title = clean(textContent(medline?.["ArticleTitle"]) ?? asString(medline?.["ArticleTitle"]));
  if (title === undefined) return undefined;
  const pmid = normalizePmid(textContent(citation?.["PMID"]) ?? asString(citation?.["PMID"]));
  const ids = articleIds(asRecord(article?.["PubmedData"])?.["ArticleIdList"]);
  const doi = ids.doi;
  const pmcid = ids.pmcid;
  const journal = asRecord(medline?.["Journal"]);
  const pubDate = asRecord(asRecord(journal?.["JournalIssue"])?.["PubDate"]);
  const yearText = asString(pubDate?.["Year"]) ?? asString(pubDate?.["MedlineDate"]);
  const year = yearText === undefined ? undefined : Number(/^(\d{4})/.exec(yearText)?.[1]);
  const abstract = abstractText(medline?.["Abstract"]);
  const venue = clean(textContent(journal?.["Title"]) ?? asString(journal?.["Title"]));
  return makePaper({
    ids: {
      ...(pmid === undefined ? {} : { pmid }),
      ...(doi === undefined ? {} : { doi }),
      ...(pmcid === undefined ? {} : { pmcid }),
    },
    title,
    authors: authorsFrom(medline?.["AuthorList"]),
    sources: ["pubmed"],
    ...(year === undefined || Number.isNaN(year) ? {} : { year }),
    ...(venue === undefined ? {} : { venue }),
    ...(abstract === undefined ? {} : { abstract, abstractNote: COPYRIGHT_ABSTRACT_NOTE }),
    urls: landingUrl(doi, pmid),
    openAccess: { isOa: false },
  });
}

function landingUrl(doi: ReturnType<typeof normalizeDoi>, pmid: ReturnType<typeof normalizePmid>): {
  landing?: string;
} {
  if (doi !== undefined) return { landing: `https://doi.org/${doi}` };
  if (pmid !== undefined) return { landing: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/` };
  return {};
}

function articleIds(value: unknown): {
  doi?: ReturnType<typeof normalizeDoi>;
  pmcid?: ReturnType<typeof normalizePmcid>;
} {
  let doi: ReturnType<typeof normalizeDoi> = undefined;
  let pmcid: ReturnType<typeof normalizePmcid> = undefined;
  for (const item of asArray(asRecord(value)?.["ArticleId"])) {
    const idType = attr(item, "IdType") ?? attr(asRecord(item), "IdType");
    const text = textContent(item) ?? asString(item);
    if (idType === "doi" && doi === undefined) doi = normalizeDoi(text);
    if (idType === "pmc" && pmcid === undefined) pmcid = normalizePmcid(text);
  }
  return { ...(doi === undefined ? {} : { doi }), ...(pmcid === undefined ? {} : { pmcid }) };
}

function authorsFrom(value: unknown): Author[] {
  const authors: Author[] = [];
  for (const item of asArray(asRecord(value)?.["Author"])) {
    const record = asRecord(item);
    if (record === undefined) continue;
    const collective = clean(asString(record["CollectiveName"]));
    const name =
      collective ??
      joinName(asString(record["ForeName"]), asString(record["LastName"]));
    if (name === undefined) continue;
    const author: Author = { name };
    const orcid = orcidFrom(record["Identifier"]);
    if (orcid !== undefined) author.orcid = orcid;
    authors.push(author);
  }
  return authors;
}

function orcidFrom(value: unknown): ReturnType<typeof normalizeOrcid> {
  for (const item of asArray(value)) {
    const source = attr(item, "Source");
    const text = textContent(item) ?? asString(item);
    if (source?.toUpperCase() === "ORCID") return normalizeOrcid(text);
  }
  return undefined;
}

function abstractText(value: unknown): string | undefined {
  const parts: string[] = [];
  for (const item of asArray(asRecord(value)?.["AbstractText"])) {
    const label = attr(item, "Label");
    const text = clean(textContent(item) ?? asString(item));
    if (text === undefined) continue;
    parts.push(label === undefined ? text : `${label}: ${text}`);
  }
  if (parts.length === 0) return undefined;
  return parts.join(" ");
}

function joinName(fore: string | undefined, last: string | undefined): string | undefined {
  const full = [fore, last].filter((part) => part !== undefined).join(" ").trim();
  return full.length > 0 ? full : undefined;
}

function clean(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const cleaned = value.replace(/\s+/g, " ").trim();
  return cleaned.length > 0 ? cleaned : undefined;
}

function pubmedTerm(request: SearchRequest): string {
  const parts = [`(${request.query})`];
  if (request.openAccessOnly) parts.push("free full text[filter]");
  if (request.yearFrom !== undefined || request.yearTo !== undefined) {
    parts.push(`${request.yearFrom ?? 1800}:${request.yearTo ?? 2100}[dp]`);
  }
  return parts.join(" AND ");
}

// E-utilities accepts NCBI_API_KEY only as the api_key query parameter.
function ncbiIdentity(ctx: SourceContext): Record<string, string> {
  const identity: Record<string, string> = {
    tool: "papers",
    email: ctx.config.contactEmail,
  };
  if (ctx.config.ncbiApiKey !== undefined) identity["api_key"] = ctx.config.ncbiApiKey;
  return identity;
}
