import { normalizeTitle, type Author, type Paper } from "./paper.js";

export type CitationFormat = "bibtex" | "ris";

export function exportCitation(paper: Paper, format: CitationFormat): string {
  return format === "bibtex" ? toBibtex(paper) : toRis(paper);
}

function toBibtex(paper: Paper): string {
  const lines = [`@article{${citationKey(paper)},`];
  pushBib(lines, "title", paper.title);
  if (paper.authors.length > 0) {
    pushBib(lines, "author", paper.authors.map(bibAuthor).join(" and "));
  }
  if (paper.year !== undefined) pushBib(lines, "year", String(paper.year));
  if (paper.venue !== undefined) pushBib(lines, "journal", paper.venue);
  if (paper.ids.doi !== undefined) pushBib(lines, "doi", paper.ids.doi);
  const url = paper.urls.landing ?? paper.urls.abs ?? paper.openAccess.oaUrl;
  if (url !== undefined) pushBib(lines, "url", url);
  if (paper.ids.pmid !== undefined) pushBib(lines, "pmid", paper.ids.pmid);
  if (paper.abstract !== undefined) pushBib(lines, "abstract", paper.abstract);
  lines.push("}");
  return lines.join("\n");
}

function toRis(paper: Paper): string {
  const lines = ["TY  - JOUR", `TI  - ${oneLine(paper.title)}`];
  for (const author of paper.authors) lines.push(`AU  - ${oneLine(author.name)}`);
  if (paper.year !== undefined) lines.push(`PY  - ${paper.year}`);
  if (paper.date !== undefined) lines.push(`DA  - ${oneLine(paper.date)}`);
  if (paper.venue !== undefined) lines.push(`JO  - ${oneLine(paper.venue)}`);
  if (paper.ids.doi !== undefined) lines.push(`DO  - ${paper.ids.doi}`);
  const url = paper.urls.landing ?? paper.urls.abs ?? paper.openAccess.oaUrl;
  if (url !== undefined) lines.push(`UR  - ${url}`);
  if (paper.abstract !== undefined) lines.push(`AB  - ${oneLine(paper.abstract)}`);
  lines.push("ER  - ");
  return lines.join("\n");
}

function pushBib(lines: string[], field: string, value: string): void {
  lines.push(`  ${field} = {${bibtexEscape(value)}},`);
}

function bibtexEscape(value: string): string {
  return oneLine(value).replace(/\\/g, "\\\\").replace(/[{}]/g, (char) => `\\${char}`);
}

function bibAuthor(author: Author): string {
  return bibtexEscape(author.name);
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function citationKey(paper: Paper): string {
  const authorName = paper.authors[0]?.name ?? "anon";
  const parts = authorName.split(" ").filter((part) => part.length > 0);
  const last = parts.at(-1) ?? "anon";
  const word = normalizeTitle(paper.title).split(" ")[0] ?? "paper";
  const year = paper.year === undefined ? "nd" : String(paper.year);
  const raw = `${last}${year}${word}`.replace(/[^A-Za-z0-9]+/g, "");
  return raw.length > 0 ? raw : "paper";
}
