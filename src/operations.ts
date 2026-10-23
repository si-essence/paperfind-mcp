import type { z } from "zod";
import { exportCitation } from "./cite.js";
import type { SourceContext } from "./context.js";
import { ConnectorError, type ConnectorErrorCode } from "./errors.js";
import {
  dedupePapers,
  isOpenLicence,
  isSourceId,
  makePaper,
  normalizeArxivId,
  normalizeDoi,
  normalizeOpenAlexId,
  normalizeOrcid,
  normalizePmcid,
  normalizePmid,
  paperRecord,
  type Author,
  type Doi,
  type OpenAccess,
  type OpenAlexId,
  type Paper,
  type PaperUrls,
  type SourceId,
  type UpstreamId,
} from "./paper.js";
import { sourcePolicies } from "./policies.js";
import type {
  exportCitationInput,
  getAuthorWorksInput,
  getCitationsInput,
  getFullTextInput,
  getPaperByDoiInput,
  getPaperInput,
  getReferencesInput,
  searchAuthorsInput,
  searchPapersInput,
  searchSourceInput,
} from "./schemas.js";
import { searchArxiv, getArxiv } from "./sources/arxiv.js";
import { crossrefReferences, getCrossrefByDoi, searchCrossref } from "./sources/crossref.js";
import { searchDoaj } from "./sources/doaj.js";
import {
  europePmcCitations,
  europePmcFullText,
  europePmcReferences,
  findEuropePmc,
  searchEuropePmc,
  type EuropePmcRecord,
} from "./sources/europepmc.js";
import {
  authorRecord,
  getOpenAlexByDoi,
  getOpenAlexWork,
  openAlexAuthorWorks,
  openAlexCitations,
  openAlexReferences,
  resolveOpenAlexId,
  searchOpenAlex,
  searchOpenAlexAuthors,
} from "./sources/openalex.js";
import { getPubmed, searchPubmed } from "./sources/pubmed.js";
import { locationRecord, unpaywallByDoi, type OaLocation, type OaReport } from "./sources/unpaywall.js";

export const DEFAULT_SOURCES: readonly SourceId[] = [
  "crossref",
  "openalex",
  "europepmc",
  "pubmed",
  "doaj",
];

interface SourceStatus {
  source: UpstreamId;
  status: "ok" | "skipped" | ConnectorErrorCode;
  count?: number;
  message?: string;
}

type SearchArgs = z.output<typeof searchPapersInput>;
type GraphArgs = z.output<typeof getCitationsInput>;

export async function searchPapers(
  ctx: SourceContext,
  args: SearchArgs,
): Promise<Record<string, unknown>> {
  const request = toSearchRequest(args);
  const sources = selectedSources(args.sources);
  const settled = await Promise.all(
    sources.map(async (source) => {
      try {
        const papers = (await runSearch(ctx, source, request)).filter((paper) =>
          matchesRequest(paper, request),
        );
        return {
          papers,
          status: { source, status: "ok" as const, count: papers.length },
        };
      } catch (error) {
        return { papers: [] as Paper[], status: statusFromError(source, error) };
      }
    }),
  );
  const papers: Paper[] = [];
  const statuses: SourceStatus[] = [];
  for (const item of settled) {
    papers.push(...item.papers);
    statuses.push(item.status);
  }
  return {
    papers: dedupePapers(papers).map(paperRecord),
    statuses: statuses.map(statusRecord),
  };
}

export async function searchSource(
  ctx: SourceContext,
  args: z.output<typeof searchSourceInput>,
): Promise<Record<string, unknown>> {
  const request = toSearchRequest(args);
  if (args.arxivCategory !== undefined) request.arxivCategory = args.arxivCategory;
  const papers = (await runSearch(ctx, args.source, request)).filter((paper) =>
    matchesRequest(paper, request),
  );
  return {
    source: args.source,
    papers: papers.map(paperRecord),
    status: statusRecord({ source: args.source, status: "ok", count: papers.length }),
  };
}

export async function getPaperByDoi(
  ctx: SourceContext,
  args: z.output<typeof getPaperByDoiInput>,
): Promise<Record<string, unknown>> {
  const resolved = await resolveByDoi(ctx, requireDoi(args.doi));
  return {
    paper: paperRecord(resolved.paper),
    statuses: resolved.statuses.map(statusRecord),
  };
}

export async function getPaper(
  ctx: SourceContext,
  args: z.output<typeof getPaperInput>,
): Promise<Record<string, unknown>> {
  switch (args.idType) {
    case "arxiv":
      return { paper: paperRecord(await getArxiv(ctx, args.id)) };
    case "pmid":
      return { paper: paperRecord(await getPubmed(ctx, args.id)) };
    case "openalex":
      return { paper: paperRecord(await getOpenAlexWork(ctx, args.id)) };
    case "pmcid": {
      const pmcid = normalizePmcid(args.id);
      if (pmcid === undefined) {
        throw new ConnectorError("invalid_input", "pmcid must look like PMC123.");
      }
      const record = await findEuropePmc(ctx, `PMCID:${pmcid}`);
      if (record === undefined) {
        throw new ConnectorError("not_found", `europepmc has no record for ${pmcid}.`);
      }
      return { paper: paperRecord(record.paper) };
    }
    default: {
      const neverType: never = args.idType;
      throw new ConnectorError("invalid_input", `Unsupported id type ${String(neverType)}.`);
    }
  }
}

export async function findOpenAccess(
  ctx: SourceContext,
  args: z.output<typeof getPaperByDoiInput>,
): Promise<Record<string, unknown>> {
  const doi = requireDoi(args.doi);
  const unpaywall = await attemptReport(ctx, doi);
  let openalex: Paper | undefined;
  let openalexStatus: SourceStatus | undefined;
  // Unpaywall is the primary OA index. OpenAlex fills in when that lookup
  // fails or returns no best location.
  if (unpaywall.report === undefined || unpaywall.report.best === null) {
    const loaded = await attemptPaper("openalex", () => getOpenAlexByDoi(ctx, doi));
    openalex = loaded.paper;
    openalexStatus = loaded.status;
  }
  const fallback = openalex === undefined ? null : locationFromPaper(openalex);
  const best = unpaywall.report?.best ?? fallback;
  const reported = unpaywall.report?.locations ?? [];
  const locations = reported.length > 0 || fallback === null ? reported : [fallback];
  const isOa = unpaywall.report?.isOa === true || openalex?.openAccess.isOa === true;
  const statuses = [unpaywall.status];
  if (openalexStatus !== undefined) statuses.push(openalexStatus);
  const reason =
    unpaywall.report === undefined && best === null
      ? "Unpaywall did not return an open-access location, and the OpenAlex fallback did not either."
      : undefined;
  return {
    doi,
    isOa,
    best: best === null ? null : locationRecord(best),
    locations: locations.map(locationRecord),
    ...(reason === undefined ? {} : { reason }),
    statuses: statuses.map(statusRecord),
  };
}

export async function getCitations(
  ctx: SourceContext,
  args: GraphArgs,
): Promise<Record<string, unknown>> {
  return relatedWorks(ctx, args, "citations");
}

export async function getReferences(
  ctx: SourceContext,
  args: z.output<typeof getReferencesInput>,
): Promise<Record<string, unknown>> {
  return relatedWorks(ctx, args, "references");
}

export async function searchAuthors(
  ctx: SourceContext,
  args: z.output<typeof searchAuthorsInput>,
): Promise<Record<string, unknown>> {
  const hits = await searchOpenAlexAuthors(ctx, args.query, args.limit ?? 5);
  return { authors: hits.map(authorRecord) };
}

export async function getAuthorWorks(
  ctx: SourceContext,
  args: z.output<typeof getAuthorWorksInput>,
): Promise<Record<string, unknown>> {
  const papers = await openAlexAuthorWorks(ctx, args.openalexId, args.page ?? 1, args.limit ?? 5);
  return { papers: papers.map(paperRecord) };
}

export async function getFullText(
  ctx: SourceContext,
  args: z.output<typeof getFullTextInput>,
): Promise<Record<string, unknown>> {
  const doi = optionalDoi(args.doi);
  const pmid = optionalPmid(args.pmid);
  const pmcid = optionalPmcid(args.pmcid);
  if (doi === undefined && pmid === undefined && pmcid === undefined) {
    if (args.arxivId !== undefined) {
      const arxivId = normalizeArxivId(args.arxivId);
      if (arxivId === undefined) {
        throw new ConnectorError("invalid_input", "arxiv id is not a valid arXiv identifier.");
      }
      return {
        fullText: null,
        license: null,
        reason: "Full text is never returned for arXiv. Use the abstract page link.",
        urls: {
          abs: `https://arxiv.org/abs/${arxivId}`,
          pdfUrl: `https://arxiv.org/pdf/${arxivId}`,
        },
      };
    }
    throw new ConnectorError("invalid_input", "Provide a doi, pmid, pmcid, or arxiv id.");
  }
  const lookup: { doi?: Doi; pmid?: string; pmcid?: string } = {};
  if (doi !== undefined) lookup.doi = doi;
  if (pmid !== undefined) lookup.pmid = pmid;
  if (pmcid !== undefined) lookup.pmcid = pmcid;
  const record = await findEuropePmc(ctx, europeLookupQuery(lookup));
  if (record === undefined) {
    return {
      fullText: null,
      license: null,
      reason: "Europe PMC has no record for this identifier.",
    };
  }
  return fullTextFromRecord(ctx, record);
}

export function listSources(ctx: SourceContext): Record<string, unknown> {
  return {
    sources: sourcePolicies(ctx.config).map((policy) => ({
      id: policy.id,
      enabled: true,
      search: policy.search,
      defaultSearch: isSourceId(policy.id) && DEFAULT_SOURCES.includes(policy.id),
      rate: policy.rate,
      termsUrl: policy.termsUrl,
      auth: policy.auth,
      never: policy.never,
    })),
    env: [
      { name: "PAPERS_CONTACT_EMAIL", set: ctx.config.contactFromEnv },
      { name: "OPENALEX_API_KEY", set: ctx.config.openAlexApiKey !== undefined },
      { name: "NCBI_API_KEY", set: ctx.config.ncbiApiKey !== undefined },
    ],
  };
}

export async function exportCitationTool(
  ctx: SourceContext,
  args: z.output<typeof exportCitationInput>,
): Promise<Record<string, unknown>> {
  const paper = args.title === undefined ? await paperForExport(ctx, args) : offlinePaper(args);
  return { format: args.format, citation: exportCitation(paper, args.format) };
}

async function paperForExport(
  ctx: SourceContext,
  args: z.output<typeof exportCitationInput>,
): Promise<Paper> {
  if (args.doi === undefined) {
    throw new ConnectorError("invalid_input", "Provide a title or a doi to export a citation.");
  }
  return (await resolveByDoi(ctx, requireDoi(args.doi))).paper;
}

async function resolveByDoi(
  ctx: SourceContext,
  doi: Doi,
): Promise<{ paper: Paper; statuses: SourceStatus[] }> {
  const [crossref, openalex, unpaywall] = await Promise.all([
    attemptPaper("crossref", () => getCrossrefByDoi(ctx, doi)),
    attemptPaper("openalex", () => getOpenAlexByDoi(ctx, doi)),
    attemptReport(ctx, doi),
  ]);
  const found = [crossref.paper, openalex.paper].filter((paper): paper is Paper => paper !== undefined);
  if (found.length === 0) {
    throwCombined([crossref.status, openalex.status], `DOI ${doi}`);
  }
  let merged = dedupePapers(found)[0];
  if (merged === undefined) {
    throw new ConnectorError("not_found", `No source returned a paper for ${doi}.`);
  }
  if (unpaywall.report !== undefined) merged = withUnpaywall(merged, unpaywall.report);
  return { paper: merged, statuses: [crossref.status, openalex.status, unpaywall.status] };
}

function offlinePaper(args: z.output<typeof exportCitationInput>): Paper {
  if (args.title === undefined) {
    throw new ConnectorError("invalid_input", "Provide a title or a doi to export a citation.");
  }
  const doi = optionalDoi(args.doi);
  const paper = makePaper({
    ids: doi === undefined ? {} : { doi },
    title: args.title,
    authors: authorsFromInput(args.authors),
    sources: [],
    ...(args.year === undefined ? {} : { year: args.year }),
    ...(args.venue === undefined ? {} : { venue: args.venue }),
    ...(args.abstract === undefined ? {} : { abstract: args.abstract }),
  });
  if (paper === undefined) {
    throw new ConnectorError("invalid_input", "title is required when doi is omitted.");
  }
  return paper;
}

function authorsFromInput(
  authors: z.output<typeof exportCitationInput>["authors"],
): Author[] {
  const out: Author[] = [];
  for (const author of authors ?? []) {
    const next: Author = { name: author.name };
    if (author.orcid !== undefined) {
      const orcid = normalizeOrcid(author.orcid);
      if (orcid === undefined) throw new ConnectorError("invalid_input", "orcid is not valid.");
      next.orcid = orcid;
    }
    out.push(next);
  }
  return out;
}

async function relatedWorks(
  ctx: SourceContext,
  args: GraphArgs,
  kind: "citations" | "references",
): Promise<Record<string, unknown>> {
  const ids = graphIds(args);
  const page = args.page ?? 1;
  const limit = args.limit ?? 5;
  const jobs: Array<Promise<{ papers: Paper[]; status: SourceStatus }>> = [
    openAlexRelated(ctx, ids, page, limit, kind),
    europeRelated(ctx, ids, page, limit, kind),
  ];
  if (kind === "references") jobs.push(crossrefRelated(ctx, ids.doi, page, limit));
  const settled = await Promise.all(jobs);
  const papers: Paper[] = [];
  const statuses: SourceStatus[] = [];
  for (const item of settled) {
    papers.push(...item.papers);
    statuses.push(item.status);
  }
  return {
    papers: dedupePapers(papers).map(paperRecord),
    statuses: statuses.map(statusRecord),
    page,
    limit,
  };
}

async function openAlexRelated(
  ctx: SourceContext,
  ids: GraphIds,
  page: number,
  limit: number,
  kind: "citations" | "references",
): Promise<{ papers: Paper[]; status: SourceStatus }> {
  if (ids.openalexId === undefined && ids.doi === undefined) {
    return {
      papers: [],
      status: {
        source: "openalex",
        status: "skipped",
        message: "OpenAlex needs a DOI or an OpenAlex work id.",
      },
    };
  }
  return attemptPapers("openalex", async () => {
    const openalexId = ids.openalexId ?? (await resolveOpenAlexId(ctx, required(ids.doi)));
    return kind === "citations"
      ? openAlexCitations(ctx, openalexId, page, limit)
      : openAlexReferences(ctx, openalexId, page, limit);
  });
}

async function europeRelated(
  ctx: SourceContext,
  ids: GraphIds,
  page: number,
  limit: number,
  kind: "citations" | "references",
): Promise<{ papers: Paper[]; status: SourceStatus }> {
  if (ids.pmid === undefined && ids.pmcid === undefined && ids.doi === undefined) {
    return {
      papers: [],
      status: {
        source: "europepmc",
        status: "skipped",
        message: "Europe PMC needs a PMID, PMCID, or DOI.",
      },
    };
  }
  return attemptPapers("europepmc", async () => {
    const target = await europeTarget(ctx, ids);
    if (target === undefined) return [];
    return kind === "citations"
      ? europePmcCitations(ctx, target.kind, target.id, page, limit)
      : europePmcReferences(ctx, target.kind, target.id, page, limit);
  });
}

async function crossrefRelated(
  ctx: SourceContext,
  doi: Doi | undefined,
  page: number,
  limit: number,
): Promise<{ papers: Paper[]; status: SourceStatus }> {
  if (doi === undefined) {
    return {
      papers: [],
      status: { source: "crossref", status: "skipped", message: "Crossref references need a DOI." },
    };
  }
  return attemptPapers("crossref", () => crossrefReferences(ctx, doi, page, limit));
}

async function europeTarget(
  ctx: SourceContext,
  ids: GraphIds,
): Promise<{ kind: "MED" | "PMC"; id: string } | undefined> {
  if (ids.pmid !== undefined) return { kind: "MED", id: ids.pmid };
  if (ids.pmcid !== undefined) return { kind: "PMC", id: ids.pmcid };
  if (ids.doi === undefined) return undefined;
  const record = await findEuropePmc(ctx, `DOI:${ids.doi}`);
  if (record?.pmid !== undefined) return { kind: "MED", id: record.pmid };
  if (record?.pmcid !== undefined) return { kind: "PMC", id: record.pmcid };
  return undefined;
}

async function fullTextFromRecord(
  ctx: SourceContext,
  record: EuropePmcRecord,
): Promise<Record<string, unknown>> {
  const paper = paperRecord(record.paper);
  if (!record.isOpenAccess) {
    return {
      fullText: null,
      license: record.license ?? null,
      reason: "Full text is returned only for an open-access record.",
      paper,
    };
  }
  if (!isOpenLicence(record.license) || record.license === undefined) {
    return {
      fullText: null,
      license: record.license ?? null,
      reason: "Full text is returned only when the open-access record carries an open licence.",
      paper,
    };
  }
  if (record.pmcid === undefined) {
    return {
      fullText: null,
      license: record.license,
      reason: "Europe PMC marked this record open access but did not provide a PMCID.",
      paper,
    };
  }
  const text = await europePmcFullText(ctx, record.pmcid);
  return {
    fullText: text.text,
    truncated: text.truncated,
    license: record.license,
    paper,
  };
}

interface GraphIds {
  doi?: Doi;
  pmid?: string;
  pmcid?: string;
  openalexId?: OpenAlexId;
}

function graphIds(args: GraphArgs): GraphIds {
  const ids: GraphIds = {};
  const doi = optionalDoi(args.doi);
  const pmid = optionalPmid(args.pmid);
  const pmcid = optionalPmcid(args.pmcid);
  const openalexId = optionalOpenAlex(args.openalexId);
  if (doi !== undefined) ids.doi = doi;
  if (pmid !== undefined) ids.pmid = pmid;
  if (pmcid !== undefined) ids.pmcid = pmcid;
  if (openalexId !== undefined) ids.openalexId = openalexId;
  if (doi === undefined && pmid === undefined && pmcid === undefined && openalexId === undefined) {
    throw new ConnectorError("invalid_input", "Provide a doi, pmid, pmcid, or openalex id.");
  }
  return ids;
}

function europeLookupQuery(ids: { doi?: Doi; pmid?: string; pmcid?: string }): string {
  if (ids.pmcid !== undefined) return `PMCID:${ids.pmcid}`;
  if (ids.pmid !== undefined) return `EXT_ID:${ids.pmid} AND SRC:MED`;
  if (ids.doi !== undefined) return `DOI:${ids.doi}`;
  throw new ConnectorError("invalid_input", "Provide a doi, pmid, or pmcid.");
}

interface SearchRequest {
  query: string;
  limit: number;
  yearFrom?: number;
  yearTo?: number;
  openAccessOnly: boolean;
  arxivCategory?: string;
}

function toSearchRequest(args: SearchArgs): SearchRequest {
  const request: SearchRequest = {
    query: args.query,
    limit: args.limit ?? 5,
    openAccessOnly: args.openAccessOnly ?? false,
  };
  if (args.yearFrom !== undefined) request.yearFrom = args.yearFrom;
  if (args.yearTo !== undefined) request.yearTo = args.yearTo;
  if (
    request.yearFrom !== undefined &&
    request.yearTo !== undefined &&
    request.yearFrom > request.yearTo
  ) {
    throw new ConnectorError("invalid_input", "yearFrom must be less than or equal to yearTo.");
  }
  if (args.arxivCategory !== undefined) request.arxivCategory = args.arxivCategory;
  return request;
}

function selectedSources(sources: readonly SourceId[] | undefined): SourceId[] {
  if (sources !== undefined && sources.length === 0) {
    throw new ConnectorError("invalid_input", "Select at least one source.");
  }
  const chosen = sources ?? DEFAULT_SOURCES;
  const out: SourceId[] = [];
  for (const source of chosen) {
    if (!out.includes(source)) out.push(source);
  }
  return [...out];
}

function matchesRequest(paper: Paper, request: SearchRequest): boolean {
  if (request.openAccessOnly && !paper.openAccess.isOa) return false;
  if (
    (request.yearFrom !== undefined || request.yearTo !== undefined) &&
    paper.year === undefined
  ) {
    return false;
  }
  if (request.yearFrom !== undefined && paper.year !== undefined && paper.year < request.yearFrom) {
    return false;
  }
  if (request.yearTo !== undefined && paper.year !== undefined && paper.year > request.yearTo) {
    return false;
  }
  return true;
}

function runSearch(ctx: SourceContext, source: SourceId, request: SearchRequest): Promise<Paper[]> {
  switch (source) {
    case "arxiv":
      return searchArxiv(ctx, request);
    case "crossref":
      return searchCrossref(ctx, request);
    case "openalex":
      return searchOpenAlex(ctx, request);
    case "europepmc":
      return searchEuropePmc(ctx, request);
    case "pubmed":
      return searchPubmed(ctx, request);
    case "doaj":
      return searchDoaj(ctx, request);
    default: {
      const neverSource: never = source;
      throw new ConnectorError("invalid_input", `Unknown source ${String(neverSource)}.`);
    }
  }
}

async function attemptPaper(
  source: UpstreamId,
  run: () => Promise<Paper>,
): Promise<{ paper?: Paper; status: SourceStatus }> {
  try {
    const paper = await run();
    return { paper, status: { source, status: "ok", count: 1 } };
  } catch (error) {
    return { status: statusFromError(source, error) };
  }
}

async function attemptPapers(
  source: UpstreamId,
  run: () => Promise<Paper[]>,
): Promise<{ papers: Paper[]; status: SourceStatus }> {
  try {
    const papers = await run();
    return { papers, status: { source, status: "ok", count: papers.length } };
  } catch (error) {
    return { papers: [], status: statusFromError(source, error) };
  }
}

async function attemptReport(
  ctx: SourceContext,
  doi: Doi,
): Promise<{ report?: OaReport; status: SourceStatus }> {
  try {
    const report = await unpaywallByDoi(ctx, doi);
    return { report, status: { source: "unpaywall", status: "ok", count: 1 } };
  } catch (error) {
    return { status: statusFromError("unpaywall", error) };
  }
}

function withUnpaywall(paper: Paper, report: OaReport): Paper {
  const best = report.best;
  const urls: PaperUrls = { ...paper.urls };
  if (urls.pdfUrl === undefined && best?.pdfUrl !== undefined) urls.pdfUrl = best.pdfUrl;
  const openAccess: OpenAccess = { isOa: paper.openAccess.isOa || report.isOa };
  const oaUrl = paper.openAccess.oaUrl ?? best?.url ?? best?.pdfUrl;
  const license = paper.openAccess.license ?? best?.license;
  const hostType = paper.openAccess.hostType ?? best?.hostType;
  if (oaUrl !== undefined) openAccess.oaUrl = oaUrl;
  if (license !== undefined) openAccess.license = license;
  if (hostType !== undefined) openAccess.hostType = hostType;
  return { ...paper, urls, openAccess };
}

function locationFromPaper(paper: Paper): OaLocation | null {
  if (!paper.openAccess.isOa) return null;
  const url = paper.openAccess.oaUrl ?? paper.urls.pdfUrl ?? paper.urls.landing;
  if (url === undefined) return null;
  const location: OaLocation = { url };
  if (paper.urls.pdfUrl !== undefined) location.pdfUrl = paper.urls.pdfUrl;
  if (paper.openAccess.license !== undefined) location.license = paper.openAccess.license;
  if (paper.openAccess.hostType !== undefined) location.hostType = paper.openAccess.hostType;
  return location;
}

function statusFromError(source: UpstreamId, error: unknown): SourceStatus {
  if (error instanceof ConnectorError) {
    return { source, status: error.code, message: error.message };
  }
  return { source, status: "upstream_unavailable", message: `${source} request failed.` };
}

function statusRecord(status: SourceStatus): Record<string, unknown> {
  return {
    source: status.source,
    status: status.status,
    ...(status.count === undefined ? {} : { count: status.count }),
    ...(status.message === undefined ? {} : { message: status.message }),
  };
}

function throwCombined(statuses: SourceStatus[], label: string): never {
  const failures = statuses.filter((status) => status.status !== "ok" && status.status !== "skipped");
  const allMissing = failures.length > 0 && failures.every((status) => status.status === "not_found");
  const detail = failures
    .map((status) => status.message)
    .filter((message): message is string => message !== undefined)
    .join(" ");
  if (allMissing) {
    throw new ConnectorError("not_found", detail || `${label} was not found.`);
  }
  throw new ConnectorError("upstream_unavailable", detail || `${label} could not be loaded.`);
}

function requireDoi(raw: string): Doi {
  const doi = normalizeDoi(raw);
  if (doi === undefined) throw new ConnectorError("invalid_input", "doi is not a valid DOI.");
  return doi;
}

function optionalDoi(raw: string | undefined): Doi | undefined {
  if (raw === undefined) return undefined;
  return requireDoi(raw);
}

function optionalPmid(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const pmid = normalizePmid(raw);
  if (pmid === undefined) throw new ConnectorError("invalid_input", "pmid must be a PubMed id.");
  return pmid;
}

function optionalPmcid(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const pmcid = normalizePmcid(raw);
  if (pmcid === undefined) throw new ConnectorError("invalid_input", "pmcid must look like PMC123.");
  return pmcid;
}

function optionalOpenAlex(raw: string | undefined): OpenAlexId | undefined {
  if (raw === undefined) return undefined;
  const id = normalizeOpenAlexId(raw, "W");
  if (id === undefined) throw new ConnectorError("invalid_input", "openalex id must look like W123.");
  return id;
}

function required(doi: Doi | undefined): Doi {
  if (doi === undefined) throw new ConnectorError("invalid_input", "doi is not a valid DOI.");
  return doi;
}

