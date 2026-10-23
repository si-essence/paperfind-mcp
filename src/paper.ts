export const SOURCE_IDS = [
  "arxiv",
  "crossref",
  "openalex",
  "europepmc",
  "pubmed",
  "doaj",
] as const;

export type SourceId = (typeof SOURCE_IDS)[number];

export const UPSTREAM_IDS = [...SOURCE_IDS, "unpaywall"] as const;

export type UpstreamId = (typeof UPSTREAM_IDS)[number];

declare const doiBrand: unique symbol;
declare const arxivBrand: unique symbol;
declare const pmidBrand: unique symbol;
declare const pmcidBrand: unique symbol;
declare const openAlexBrand: unique symbol;
declare const doajBrand: unique symbol;
declare const orcidBrand: unique symbol;

export type Doi = string & { readonly [doiBrand]: "Doi" };
export type ArxivId = string & { readonly [arxivBrand]: "ArxivId" };
export type Pmid = string & { readonly [pmidBrand]: "Pmid" };
export type Pmcid = string & { readonly [pmcidBrand]: "Pmcid" };
export type OpenAlexId = string & { readonly [openAlexBrand]: "OpenAlexId" };
export type DoajId = string & { readonly [doajBrand]: "DoajId" };
export type Orcid = string & { readonly [orcidBrand]: "Orcid" };

export interface Author {
  name: string;
  orcid?: Orcid;
}

export interface PaperIds {
  doi?: Doi;
  arxivId?: ArxivId;
  pmid?: Pmid;
  pmcid?: Pmcid;
  openalexId?: OpenAlexId;
  doajId?: DoajId;
}

export interface PaperUrls {
  landing?: string;
  abs?: string;
  pdfUrl?: string;
}

export interface OpenAccess {
  isOa: boolean;
  oaUrl?: string;
  license?: string;
  hostType?: string;
}

export interface Paper {
  ids: PaperIds;
  title: string;
  authors: Author[];
  year?: number;
  date?: string;
  venue?: string;
  abstract?: string;
  abstractNote?: string;
  urls: PaperUrls;
  openAccess: OpenAccess;
  citationCount?: number;
  sources: SourceId[];
}

export const COPYRIGHT_ABSTRACT_NOTE =
  "Abstracts from this source may be publisher or author copyright. This connector does not grant a licence to reuse them.";

const STRONG_ID_KEYS = ["doi", "pmid", "pmcid", "arxivId", "openalexId", "doajId"] as const;

export function isSourceId(value: string): value is SourceId {
  return (SOURCE_IDS as readonly string[]).includes(value);
}

export function normalizeDoi(raw: string | undefined): Doi | undefined {
  if (raw === undefined) return undefined;
  let value = raw.trim();
  value = value.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "");
  value = value.replace(/^doi:\s*/i, "");
  try {
    value = decodeURIComponent(value);
  } catch {
    return undefined;
  }
  value = value.trim().replace(/[.)\],;]+$/g, "").toLowerCase();
  if (!/^10\.\d{4,9}\/\S+$/.test(value)) return undefined;
  return value as Doi;
}

export function normalizeArxivId(raw: string | undefined): ArxivId | undefined {
  if (raw === undefined) return undefined;
  let value = raw.trim();
  value = value.replace(/^https?:\/\/arxiv\.org\/(?:abs|pdf)\//i, "");
  value = value.replace(/\.pdf$/i, "");
  value = value.replace(/^arxiv:/i, "");
  value = value.replace(/v\d+$/i, "");
  if (/^\d{4}\.\d{4,5}$/.test(value)) return value as ArxivId;
  if (/^[a-z][a-z.-]*\/\d{7}$/i.test(value)) return value.toLowerCase() as ArxivId;
  return undefined;
}

export function normalizePmid(raw: string | undefined): Pmid | undefined {
  if (raw === undefined) return undefined;
  const match = raw.trim().match(/(\d{1,9})$/);
  if (match?.[1] === undefined) return undefined;
  const value = match[1].replace(/^0+(?=\d)/, "");
  if (!/^[1-9]\d{0,8}$/.test(value)) return undefined;
  return value as Pmid;
}

export function normalizePmcid(raw: string | undefined): Pmcid | undefined {
  if (raw === undefined) return undefined;
  const match = raw.trim().match(/PMC0*(\d{1,9})/i);
  if (match?.[1] === undefined) return undefined;
  return `PMC${match[1]}` as Pmcid;
}

export function normalizeOpenAlexId(
  raw: string | undefined,
  kind: "W" | "A",
): OpenAlexId | undefined {
  if (raw === undefined) return undefined;
  const match = raw.trim().match(new RegExp(`(?:^|/)${kind}(\\d{1,12})$`, "i"));
  if (match?.[1] === undefined) return undefined;
  return `${kind}${match[1]}` as OpenAlexId;
}

export function normalizeDoajId(raw: string | undefined): DoajId | undefined {
  if (raw === undefined) return undefined;
  const value = raw.trim();
  if (!/^[A-Za-z0-9_-]{4,80}$/.test(value)) return undefined;
  return value as DoajId;
}

export function normalizeOrcid(raw: string | undefined): Orcid | undefined {
  if (raw === undefined) return undefined;
  const match = raw.match(/(\d{4}-\d{4}-\d{4}-\d{3}[\dXx])/);
  if (match?.[1] === undefined) return undefined;
  return match[1].toUpperCase() as Orcid;
}

export function normalizeTitle(title: string): string {
  const folded = title.normalize("NFKD").replace(/\p{M}+/gu, "");
  return folded
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function yearFromDate(date: string | undefined): number | undefined {
  if (date === undefined) return undefined;
  const match = /^(\d{4})/.exec(date.trim());
  if (match?.[1] === undefined) return undefined;
  const year = Number(match[1]);
  if (year < 1500 || year > 2100) return undefined;
  return year;
}

export interface PaperDraft {
  ids: PaperIds;
  title: string;
  authors: Author[];
  sources: SourceId[];
  year?: number;
  date?: string;
  venue?: string;
  abstract?: string;
  abstractNote?: string;
  urls?: PaperUrls;
  openAccess?: OpenAccess;
  citationCount?: number;
}

export function makePaper(draft: PaperDraft): Paper | undefined {
  const title = draft.title.replace(/\s+/g, " ").trim();
  if (title.length === 0) return undefined;
  const year = draft.year ?? yearFromDate(draft.date);
  const paper: Paper = {
    ids: compactIds(draft.ids),
    title,
    authors: draft.authors.filter((author) => author.name.trim().length > 0),
    urls: compactUrls(draft.urls ?? {}),
    openAccess: compactOpenAccess(draft.openAccess ?? { isOa: false }),
    sources: uniqueSources(draft.sources),
  };
  if (year !== undefined) paper.year = year;
  if (draft.date !== undefined && draft.date.trim().length > 0) paper.date = draft.date.trim();
  if (draft.venue !== undefined && draft.venue.trim().length > 0) paper.venue = draft.venue.trim();
  if (draft.abstract !== undefined && draft.abstract.trim().length > 0) {
    paper.abstract = draft.abstract.replace(/\s+/g, " ").trim();
    if (draft.abstractNote !== undefined) paper.abstractNote = draft.abstractNote;
  }
  if (draft.citationCount !== undefined && draft.citationCount >= 0) {
    paper.citationCount = draft.citationCount;
  }
  return paper;
}

export function paperRecord(paper: Paper): Record<string, unknown> {
  return compactRecord({
    ids: compactRecord({ ...paper.ids }),
    title: paper.title,
    authors: paper.authors.map((author) => compactRecord({ ...author })),
    year: paper.year,
    date: paper.date,
    venue: paper.venue,
    abstract: paper.abstract,
    abstractNote: paper.abstractNote,
    urls: compactRecord({ ...paper.urls }),
    openAccess: compactRecord({ ...paper.openAccess }),
    citationCount: paper.citationCount,
    sources: paper.sources,
  });
}

function idsConflict(left: Paper, right: Paper): boolean {
  for (const key of STRONG_ID_KEYS) {
    const a = left.ids[key];
    const b = right.ids[key];
    if (a !== undefined && b !== undefined && a !== b) return true;
  }
  return false;
}

function sharesStrongId(left: Paper, right: Paper): boolean {
  for (const key of STRONG_ID_KEYS) {
    const a = left.ids[key];
    const b = right.ids[key];
    if (a !== undefined && b !== undefined && a === b) return true;
  }
  return false;
}

function titleYearKey(paper: Paper): string | undefined {
  if (paper.year === undefined) return undefined;
  const title = normalizeTitle(paper.title);
  if (title.length === 0) return undefined;
  return `${title}\n${paper.year}`;
}

function titleMatch(left: Paper, right: Paper): boolean {
  const leftKey = titleYearKey(left);
  const rightKey = titleYearKey(right);
  return leftKey !== undefined && leftKey === rightKey;
}

function groupsMatch(left: Paper[], right: Paper[]): boolean {
  for (const a of left) {
    for (const b of right) {
      if (idsConflict(a, b)) return false;
    }
  }
  for (const a of left) {
    for (const b of right) {
      if (sharesStrongId(a, b) || titleMatch(a, b)) return true;
    }
  }
  return false;
}

export function dedupePapers(papers: Paper[]): Paper[] {
  const groups: Paper[][] = [];
  for (const paper of papers) groups.push([paper]);
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < groups.length; i += 1) {
      for (let j = i + 1; j < groups.length; j += 1) {
        const left = groups[i];
        const right = groups[j];
        if (left === undefined || right === undefined) continue;
        if (!groupsMatch(left, right)) continue;
        groups[i] = [...left, ...right];
        groups.splice(j, 1);
        changed = true;
        break;
      }
      if (changed) break;
    }
  }
  const merged: Paper[] = [];
  for (const group of groups) {
    const first = group[0];
    if (first === undefined) continue;
    let acc = first;
    for (let i = 1; i < group.length; i += 1) {
      const next = group[i];
      if (next !== undefined) acc = mergePapers(acc, next);
    }
    merged.push(acc);
  }
  return merged;
}

export function mergePapers(left: Paper, right: Paper): Paper {
  const abstract = pickAbstract(left, right);
  const merged: Paper = {
    ids: mergeIds(left.ids, right.ids),
    title: richerText(left.title, right.title) ?? left.title,
    authors: mergeAuthors(left.authors, right.authors),
    urls: {
      ...fillUrls(left.urls, right.urls),
    },
    openAccess: mergeOpenAccess(left.openAccess, right.openAccess),
    sources: uniqueSources([...left.sources, ...right.sources]),
  };
  const year = left.year ?? right.year;
  if (year !== undefined) merged.year = year;
  const date = richerText(left.date, right.date);
  if (date !== undefined) merged.date = date;
  const venue = richerText(left.venue, right.venue);
  if (venue !== undefined) merged.venue = venue;
  if (abstract.text !== undefined) merged.abstract = abstract.text;
  if (abstract.note !== undefined) merged.abstractNote = abstract.note;
  const citations = maxCount(left.citationCount, right.citationCount);
  if (citations !== undefined) merged.citationCount = citations;
  return merged;
}

function pickAbstract(
  left: Paper,
  right: Paper,
): { text: string | undefined; note: string | undefined } {
  const ranked = [left, right].sort((a, b) => abstractScore(b) - abstractScore(a));
  const best = ranked[0];
  if (best?.abstract === undefined) return { text: undefined, note: undefined };
  return {
    text: best.abstract,
    note: best.abstractNote,
  };
}

function abstractScore(paper: Paper): number {
  if (paper.abstract === undefined) return 0;
  const openBonus = paper.abstractNote === undefined ? 1_000_000 : 0;
  return openBonus + paper.abstract.length;
}

function mergeIds(left: PaperIds, right: PaperIds): PaperIds {
  const ids: PaperIds = {};
  for (const key of STRONG_ID_KEYS) {
    const value = left[key] ?? right[key];
    if (value !== undefined) {
      assignId(ids, key, value);
    }
  }
  return ids;
}

function assignId(ids: PaperIds, key: (typeof STRONG_ID_KEYS)[number], value: string): void {
  switch (key) {
    case "doi":
      ids.doi = value as Doi;
      return;
    case "pmid":
      ids.pmid = value as Pmid;
      return;
    case "pmcid":
      ids.pmcid = value as Pmcid;
      return;
    case "arxivId":
      ids.arxivId = value as ArxivId;
      return;
    case "openalexId":
      ids.openalexId = value as OpenAlexId;
      return;
    case "doajId":
      ids.doajId = value as DoajId;
      return;
    default: {
      const neverKey: never = key;
      return neverKey;
    }
  }
}

function mergeAuthors(left: Author[], right: Author[]): Author[] {
  const out: Author[] = [];
  const index = new Map<string, number>();
  for (const author of [...left, ...right]) {
    const name = author.name.replace(/\s+/g, " ").trim();
    if (name.length === 0) continue;
    const key = normalizeTitle(name);
    const existingIndex = index.get(key);
    if (existingIndex === undefined) {
      index.set(key, out.length);
      const next: Author = { name };
      if (author.orcid !== undefined) next.orcid = author.orcid;
      out.push(next);
      continue;
    }
    const existing = out[existingIndex];
    if (existing !== undefined && existing.orcid === undefined && author.orcid !== undefined) {
      existing.orcid = author.orcid;
    }
  }
  return out;
}

function mergeOpenAccess(left: OpenAccess, right: OpenAccess): OpenAccess {
  const primary = left.isOa ? left : right.isOa ? right : left;
  const secondary = primary === left ? right : left;
  const merged: OpenAccess = { isOa: left.isOa || right.isOa };
  const oaUrl = primary.oaUrl ?? secondary.oaUrl;
  const license = primary.license ?? secondary.license;
  const hostType = primary.hostType ?? secondary.hostType;
  if (oaUrl !== undefined) merged.oaUrl = oaUrl;
  if (license !== undefined) merged.license = license;
  if (hostType !== undefined) merged.hostType = hostType;
  return merged;
}

function fillUrls(left: PaperUrls, right: PaperUrls): PaperUrls {
  const urls: PaperUrls = {};
  const landing = left.landing ?? right.landing;
  const abs = left.abs ?? right.abs;
  const pdfUrl = left.pdfUrl ?? right.pdfUrl;
  if (landing !== undefined) urls.landing = landing;
  if (abs !== undefined) urls.abs = abs;
  if (pdfUrl !== undefined) urls.pdfUrl = pdfUrl;
  return urls;
}

function richerText(left: string | undefined, right: string | undefined): string | undefined {
  if (left === undefined) return right;
  if (right === undefined) return left;
  return right.trim().length > left.trim().length ? right : left;
}

function maxCount(left: number | undefined, right: number | undefined): number | undefined {
  if (left === undefined) return right;
  if (right === undefined) return left;
  return Math.max(left, right);
}

function uniqueSources(sources: SourceId[]): SourceId[] {
  const out: SourceId[] = [];
  for (const source of sources) {
    if (!out.includes(source)) out.push(source);
  }
  return out;
}

function compactIds(ids: PaperIds): PaperIds {
  const out: PaperIds = {};
  for (const key of STRONG_ID_KEYS) {
    const value = ids[key];
    if (value !== undefined) assignId(out, key, value);
  }
  return out;
}

function compactUrls(urls: PaperUrls): PaperUrls {
  const out: PaperUrls = {};
  if (urls.landing !== undefined && urls.landing.length > 0) out.landing = urls.landing;
  if (urls.abs !== undefined && urls.abs.length > 0) out.abs = urls.abs;
  if (urls.pdfUrl !== undefined && urls.pdfUrl.length > 0) out.pdfUrl = urls.pdfUrl;
  return out;
}

function compactOpenAccess(access: OpenAccess): OpenAccess {
  const out: OpenAccess = { isOa: access.isOa };
  if (access.oaUrl !== undefined && access.oaUrl.length > 0) out.oaUrl = access.oaUrl;
  if (access.license !== undefined && access.license.length > 0) out.license = access.license;
  if (access.hostType !== undefined && access.hostType.length > 0) out.hostType = access.hostType;
  return out;
}

export function compactRecord(value: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined) out[key] = entry;
  }
  return out;
}

export function isOpenLicence(license: string | undefined): boolean {
  if (license === undefined) return false;
  const value = license.trim().toLowerCase().replace(/_/g, " ");
  if (value.length === 0) return false;
  if (value.includes("creativecommons.org") || value.includes("creative commons")) return true;
  if (value === "public domain" || value === "pd") return true;
  if (/^cc0\b/.test(value)) return true;
  if (/^cc[-\s]/.test(value)) return true;
  return false;
}
