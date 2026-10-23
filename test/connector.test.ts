import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { CONNECTOR_NAME } from "../src/constants.js";
import { loadConfig } from "../src/config.js";
import { createRuntime } from "../src/runtime.js";
import { routeFixture, text, xml } from "./fixtures.js";
import { assertNoPdfFetches, callTool, startPapers, type Session } from "./harness.js";

const TOOLS = [
  "search_papers",
  "search_source",
  "get_paper_by_doi",
  "get_paper",
  "find_open_access",
  "get_citations",
  "get_references",
  "search_authors",
  "get_author_works",
  "get_full_text",
  "list_sources",
  "export_citation",
] as const;

function asRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("expected object");
  }
  return value as Record<string, unknown>;
}

function data(result: { text: string; isError: boolean }): Record<string, unknown> {
  expect(result.isError).toBe(false);
  return asRecord(JSON.parse(result.text) as unknown);
}

function papersOf(body: Record<string, unknown>): Record<string, unknown>[] {
  const value = body["papers"];
  if (!Array.isArray(value)) throw new Error("expected papers");
  return value.map(asRecord);
}

function statusesOf(body: Record<string, unknown>): Record<string, unknown>[] {
  const value = body["statuses"];
  if (!Array.isArray(value)) throw new Error("expected statuses");
  return value.map(asRecord);
}

function idsOf(paper: Record<string, unknown>): Record<string, unknown> {
  return asRecord(paper["ids"]);
}

function sourcesOf(paper: Record<string, unknown>): string[] {
  const value = paper["sources"];
  if (!Array.isArray(value)) throw new Error("expected sources");
  return value.map(String);
}

function statusFor(body: Record<string, unknown>, source: string): Record<string, unknown> {
  const found = statusesOf(body).find((status) => status["source"] === source);
  if (found === undefined) throw new Error(`missing status ${source}`);
  return found;
}

async function withSession(
  run: (session: Session) => Promise<void>,
  options?: Parameters<typeof startPapers>[0],
): Promise<void> {
  const session = await startPapers(options);
  try {
    await run(session);
    assertNoPdfFetches(session.hits);
  } finally {
    await session.close();
  }
}

describe("papers tools", () => {
  it("publishes twelve read-only tools", async () => {
    await withSession(async ({ client }) => {
      const listed = await client.listTools();
      const names = listed.tools.map((tool) => tool.name).sort();
      expect(names).toEqual([...TOOLS].sort());
      for (const tool of listed.tools) {
        expect((tool.description ?? "").trim().length).toBeGreaterThan(0);
        expect(tool.annotations?.readOnlyHint).toBe(true);
        expect(tool.annotations?.destructiveHint).toBe(false);
      }
    });
  });

  it("keeps the package name aligned with package.json", () => {
    const pkg = z
      .object({ name: z.string() })
      .parse(JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")));
    expect(pkg.name).toBe(CONNECTOR_NAME);
  });

  it("lists sources and env names without values", async () => {
    await withSession(
      async ({ client }) => {
        const body = data(await callTool(client, "list_sources", {}));
        const text = JSON.stringify(body);
        expect(text).not.toContain("contact@example.com");
        expect(text).not.toContain("abcd1234secret");
        const sources = body["sources"];
        if (!Array.isArray(sources)) throw new Error("sources");
        const ids = sources.map((source) => asRecord(source)["id"]);
        expect(ids).toEqual([
          "arxiv",
          "crossref",
          "openalex",
          "europepmc",
          "pubmed",
          "doaj",
          "unpaywall",
        ]);
        const arxiv = asRecord(sources[0]);
        expect(arxiv["rate"]).toContain("3s");
        const crossref = asRecord(sources[1]);
        expect(crossref["rate"]).toContain("3 requests/s");
        expect(asRecord(sources[6])["search"]).toBe(false);
        const env = body["env"];
        if (!Array.isArray(env)) throw new Error("env");
        expect(env).toEqual([
          { name: "PAPERS_CONTACT_EMAIL", set: true },
          { name: "OPENALEX_API_KEY", set: true },
          { name: "NCBI_API_KEY", set: false },
        ]);
      },
      { env: { PAPERS_CONTACT_EMAIL: "contact@example.com", OPENALEX_API_KEY: "abcd1234secret" } },
    );
  });

  it("rejects invalid input before any fetch", async () => {
    await withSession(async ({ client, hits }) => {
      const backwards = await callTool(client, "search_papers", {
        query: "attention",
        yearFrom: 2024,
        yearTo: 2020,
      });
      expect(backwards.isError).toBe(true);
      expect(backwards.text).toContain("[invalid-input]");
      expect(backwards.text).not.toMatch(/\.ts:\d+/);

      const empty = await callTool(client, "search_papers", { query: "attention", sources: [] });
      expect(empty.isError).toBe(true);
      expect(empty.text).toContain("at least one source");

      const doi = await callTool(client, "get_paper_by_doi", { doi: "not-a-doi" });
      expect(doi.isError).toBe(true);
      expect(doi.text).toContain("[invalid-input]");
      expect(hits).toHaveLength(0);
    });
  });

  it("dedupes DOI prefix and case variants and keeps the richest metadata", async () => {
    await withSession(async ({ client }) => {
      const body = data(
        await callTool(client, "search_papers", {
          query: "attention",
          sources: ["arxiv", "crossref", "openalex"],
          limit: 5,
        }),
      );
      expect(papersOf(body)).toHaveLength(1);
      const paper = papersOf(body)[0];
      if (paper === undefined) throw new Error("paper");
      expect(sourcesOf(paper).sort()).toEqual(["arxiv", "crossref", "openalex"]);
      expect(idsOf(paper)["doi"]).toBe("10.1000/transformer");
      expect(idsOf(paper)["arxivId"]).toBe("2401.00001");
      expect(idsOf(paper)["openalexId"]).toBe("W123");
      expect(paper["citationCount"]).toBe(99);
      expect(paper["abstract"]).toBe("A transformer abstract from the preprint.");
      expect(paper["abstractNote"]).toBeUndefined();
      const authors = paper["authors"];
      if (!Array.isArray(authors)) throw new Error("authors");
      expect(asRecord(authors[0])["orcid"]).toBe("0000-0002-1825-0097");
      expect(asRecord(paper["urls"])["pdfUrl"]).toContain("arxiv.org/pdf/");
      for (const source of ["arxiv", "crossref", "openalex"]) {
        expect(statusFor(body, source)["status"]).toBe("ok");
      }
    });
  });

  it("merges title and year duplicates after folding punctuation and diacritics", async () => {
    await withSession(async ({ client }) => {
      const body = data(
        await callTool(client, "search_papers", {
          query: "latte",
          sources: ["doaj", "europepmc"],
        }),
      );
      expect(papersOf(body)).toHaveLength(1);
      const paper = papersOf(body)[0];
      if (paper === undefined) throw new Error("paper");
      expect(sourcesOf(paper).sort()).toEqual(["doaj", "europepmc"]);
      expect(idsOf(paper)["doi"]).toBeUndefined();
      expect(idsOf(paper)["doajId"]).toBe("doajcafe01");
      expect(idsOf(paper)["pmid"]).toBe("555");
      expect(paper["year"]).toBe(2021);
      const authors = paper["authors"];
      if (!Array.isArray(authors)) throw new Error("authors");
      expect(asRecord(authors[0])["orcid"]).toBe("0000-0001-5109-3700");
    });
  });

  it("does not merge papers that share a title when the DOIs differ", async () => {
    await withSession(async ({ client }) => {
      const body = data(
        await callTool(client, "search_papers", {
          query: "split",
          sources: ["crossref", "openalex"],
        }),
      );
      const found = papersOf(body);
      expect(found).toHaveLength(2);
      const dois = found.map((paper) => idsOf(paper)["doi"]).sort();
      expect(dois).toEqual(["10.1000/alpha", "10.1000/beta"]);
    });
  });

  it("returns the sources that worked when one source fails", async () => {
    await withSession(
      async ({ client, hits }) => {
        const body = data(
          await callTool(client, "search_papers", {
            query: "attention",
            sources: ["crossref", "openalex"],
          }),
        );
        expect(papersOf(body)).toHaveLength(1);
        expect(statusFor(body, "openalex")["status"]).toBe("ok");
        expect(statusFor(body, "crossref")["status"]).toBe("upstream_unavailable");
        expect(String(statusFor(body, "crossref")["message"])).toContain("crossref");
        expect(hits.filter((hit) => hit.url.includes("api.crossref.org"))).toHaveLength(3);
      },
      {
        router: (url) => {
          if (url.hostname === "api.crossref.org") return text("down", 500);
          return routeFixture(url);
        },
      },
    );
  });

  it("filters closed papers and years that fall outside the request", async () => {
    await withSession(async ({ client }) => {
      const closed = data(
        await callTool(client, "search_papers", {
          query: "closed",
          sources: ["crossref"],
          openAccessOnly: true,
        }),
      );
      expect(papersOf(closed)).toHaveLength(0);
      expect(statusFor(closed, "crossref")["status"]).toBe("ok");
      expect(statusFor(closed, "crossref")["count"]).toBe(0);

      const future = data(
        await callTool(client, "search_papers", {
          query: "attention",
          sources: ["crossref"],
          yearFrom: 2030,
        }),
      );
      expect(papersOf(future)).toHaveLength(0);
    });
  });

  it("leaves arXiv out of the default search and still reports every default source", async () => {
    await withSession(async ({ client }) => {
      const body = data(await callTool(client, "search_papers", { query: "attention", limit: 3 }));
      const names = statusesOf(body).map((status) => status["source"]);
      expect(names).toEqual(["crossref", "openalex", "europepmc", "pubmed", "doaj"]);
      expect(names).not.toContain("arxiv");
      expect(papersOf(body).length).toBeGreaterThan(0);
    });
  });

  it("keeps PubMed free-full-text hits when the caller asks for open access", async () => {
    await withSession(async ({ client, hits }) => {
      const body = data(
        await callTool(client, "search_source", {
          source: "pubmed",
          query: "attention",
          openAccessOnly: true,
        }),
      );
      const found = papersOf(body);
      expect(found).toHaveLength(1);
      expect(asRecord(found[0]?.["openAccess"])["isOa"]).toBe(true);
      const esearch = hits.find((hit) => hit.url.includes("esearch"));
      expect(decodeURIComponent(esearch?.url ?? "").replaceAll("+", " ")).toContain(
        "free full text[filter]",
      );
      expect(decodeURIComponent(esearch?.url ?? "")).toContain("tool=papers");
      expect(decodeURIComponent(esearch?.url ?? "")).toContain("email=contact@example.com");
    });
  });

  it("searches one source and returns its fields", async () => {
    await withSession(async ({ client, hits }) => {
      const arxiv = data(
        await callTool(client, "search_source", {
          source: "arxiv",
          query: "attention",
          arxivCategory: "cs.CL",
        }),
      );
      const arxivPaper = papersOf(arxiv)[0];
      if (arxivPaper === undefined) throw new Error("arxiv");
      expect(idsOf(arxivPaper)["arxivId"]).toBe("2401.00001");
      expect(decodeURIComponent(hits[0]?.url ?? "")).toContain("cat:cs.CL");

      const crossref = data(
        await callTool(client, "search_source", { source: "crossref", query: "attention" }),
      );
      const crossrefHit = hits.find((hit) => hit.url.includes("api.crossref.org"));
      expect(decodeURIComponent(crossrefHit?.url ?? "")).toContain("mailto=contact@example.com");
      expect(crossrefHit?.headers.get("user-agent")).toBe(
        "papers/0.1.0 (mailto:contact@example.com)",
      );
      expect(papersOf(crossref)[0]?.["abstractNote"]).toContain("copyright");

      const openalex = data(
        await callTool(client, "search_source", { source: "openalex", query: "attention" }),
      );
      expect(papersOf(openalex)[0]?.["abstract"]).toBe("Short OA abstract");

      const doaj = data(
        await callTool(client, "search_source", { source: "doaj", query: "attention" }),
      );
      const doajPaper = papersOf(doaj)[0];
      if (doajPaper === undefined) throw new Error("doaj");
      expect(idsOf(doajPaper)["doi"]).toBe("10.3000/doaj");
      expect(idsOf(doajPaper)["doajId"]).toBe("doajattn01");
      expect(asRecord(doajPaper["openAccess"])["isOa"]).toBe(true);

      const europe = data(
        await callTool(client, "search_source", { source: "europepmc", query: "attention" }),
      );
      expect(idsOf(papersOf(europe)[0] ?? {})["pmid"]).toBe("42");

      const pubmed = data(
        await callTool(client, "search_source", { source: "pubmed", query: "attention" }),
      );
      const pubmedPaper = papersOf(pubmed)[0];
      if (pubmedPaper === undefined) throw new Error("pubmed");
      expect(idsOf(pubmedPaper)["doi"]).toBe("10.2000/pubmed");
      expect(idsOf(pubmedPaper)["pmcid"]).toBe("PMC42");
      expect(pubmedPaper["abstract"]).toContain("BACKGROUND: Cells grow.");
      expect(pubmedPaper["abstractNote"]).toContain("copyright");
    });
  });

  it("spaces arXiv calls by at least 3 seconds and runs one at a time", async () => {
    await withSession(
      async ({ client, hits, sleeps, peakInflight }) => {
        const first = callTool(client, "search_source", { source: "arxiv", query: "alpha" });
        const second = callTool(client, "search_source", { source: "arxiv", query: "beta" });
        const results = await Promise.all([first, second]);
        expect(results[0].isError).toBe(false);
        expect(results[1].isError).toBe(false);
        const arxivHits = hits.filter((hit) => hit.url.includes("export.arxiv.org"));
        expect(arxivHits).toHaveLength(2);
        const start = arxivHits[0]?.at ?? 0;
        const next = arxivHits[1]?.at ?? 0;
        expect(next - start).toBeGreaterThanOrEqual(3000);
        expect(sleeps.some((ms) => ms >= 3000)).toBe(true);
        expect(peakInflight()).toBe(1);
      },
      {
        router: async (url) => {
          await new Promise((resolve) => {
            setTimeout(resolve, 15);
          });
          return routeFixture(url);
        },
      },
    );
  });

  it("loads a paper by arXiv id, PMID, PMCID, or OpenAlex id", async () => {
    await withSession(async ({ client, hits }) => {
      const arxiv = data(
        await callTool(client, "get_paper", { idType: "arxiv", id: "2401.00001v2" }),
      );
      expect(idsOf(asRecord(arxiv["paper"]))["arxivId"]).toBe("2401.00001");
      expect(hits.every((hit) => !hit.url.includes("/pdf"))).toBe(true);

      const missing = await callTool(client, "get_paper", { idType: "arxiv", id: "9999.99999" });
      expect(missing.isError).toBe(true);
      expect(missing.text).toContain("[not-found]");
      expect(missing.text).toContain("arxiv");

      const pmid = data(await callTool(client, "get_paper", { idType: "pmid", id: "12345" }));
      expect(idsOf(asRecord(pmid["paper"]))["pmid"]).toBe("12345");

      const pmcid = data(await callTool(client, "get_paper", { idType: "pmcid", id: "PMC999" }));
      expect(asRecord(pmcid["paper"])["title"]).toBe("PMC Record");

      const openalex = data(
        await callTool(client, "get_paper", { idType: "openalex", id: "W123" }),
      );
      expect(idsOf(asRecord(openalex["paper"]))["openalexId"]).toBe("W123");

      const bad = await callTool(client, "get_paper", { idType: "pmid", id: "nope" });
      expect(bad.isError).toBe(true);
      expect(bad.text).toContain("[invalid-input]");
    });
  });

  it("merges a DOI from Crossref, OpenAlex, and Unpaywall", async () => {
    await withSession(async ({ client, hits }) => {
      const body = data(
        await callTool(client, "get_paper_by_doi", { doi: "doi:10.1000/TRANSFORMER" }),
      );
      const paper = asRecord(body["paper"]);
      expect(idsOf(paper)["doi"]).toBe("10.1000/transformer");
      expect(sourcesOf(paper).sort()).toEqual(["crossref", "openalex"]);
      expect(paper["citationCount"]).toBe(99);
      for (const source of ["crossref", "openalex", "unpaywall"]) {
        expect(statusFor(body, source)["status"]).toBe("ok");
      }
      expect(hits.map((hit) => new URL(hit.url).hostname).sort()).toEqual([
        "api.crossref.org",
        "api.openalex.org",
        "api.unpaywall.org",
      ]);
    });
  });

  it("reports not found when every DOI source misses", async () => {
    await withSession(async ({ client }) => {
      const missing = await callTool(client, "get_paper_by_doi", { doi: "10.9000/missing" });
      expect(missing.isError).toBe(true);
      expect(missing.text).toContain("[not-found]");
      expect(missing.text).toContain("crossref");
    });
  });

  it("returns Unpaywall locations and falls back to OpenAlex when Unpaywall has none", async () => {
    await withSession(async ({ client, hits }) => {
      const direct = data(await callTool(client, "find_open_access", { doi: "10.1000/transformer" }));
      const best = asRecord(direct["best"]);
      expect(best["license"]).toBe("cc-by");
      expect(best["version"]).toBe("publishedVersion");
      expect(best["pdfUrl"]).toBe("https://oa.example/paper.pdf");
      expect(direct["isOa"]).toBe(true);
      const locations = direct["locations"];
      expect(Array.isArray(locations) && locations.length).toBe(1);
      expect(hits.some((hit) => hit.url.includes("api.openalex.org"))).toBe(false);

      const before = hits.length;
      const fallback = data(await callTool(client, "find_open_access", { doi: "10.5000/empty" }));
      expect(asRecord(fallback["best"])["url"]).toContain("oa.example");
      expect(statusFor(fallback, "unpaywall")["status"]).toBe("ok");
      expect(statusFor(fallback, "openalex")["status"]).toBe("ok");
      expect(hits.slice(before).some((hit) => hit.url.includes("api.openalex.org"))).toBe(true);

      const down = data(await callTool(client, "find_open_access", { doi: "10.9000/missing" }));
      expect(down["best"]).toBeNull();
      expect(down["isOa"]).toBe(false);
      expect(String(down["reason"])).toContain("Unpaywall");
      expect(statusFor(down, "unpaywall")["status"]).toBe("not_found");
      expect(statusFor(down, "openalex")["status"]).toBe("not_found");
    });
  });

  it("lists citations and references without failing the call when a source is skipped", async () => {
    await withSession(async ({ client }) => {
      const citations = data(
        await callTool(client, "get_citations", { openalexId: "W123", limit: 5 }),
      );
      expect(papersOf(citations).map((paper) => paper["title"])).toContain("Citing Work");
      expect(statusFor(citations, "europepmc")["status"]).toBe("skipped");

      const page = data(
        await callTool(client, "get_references", { openalexId: "W123", page: 2, limit: 1 }),
      );
      expect(papersOf(page).map((paper) => paper["title"])).toEqual(["Second Reference"]);
      expect(statusFor(page, "crossref")["status"]).toBe("skipped");

      const byDoi = data(
        await callTool(client, "get_references", { doi: "10.1000/transformer", limit: 5 }),
      );
      const titles = papersOf(byDoi).map((paper) => paper["title"]);
      expect(titles).toEqual(
        expect.arrayContaining(["First Reference", "Crossref Ref One", "Europe Cited Work"]),
      );
      for (const source of ["openalex", "crossref", "europepmc"]) {
        expect(statusFor(byDoi, source)["status"]).toBe("ok");
      }
    });
  });

  it("keeps citation hits from Europe PMC when OpenAlex fails", async () => {
    await withSession(
      async ({ client }) => {
        const body = data(
          await callTool(client, "get_citations", { pmid: "42", openalexId: "W123", limit: 5 }),
        );
        expect(papersOf(body).map((paper) => paper["title"])).toContain("Citing Paper");
        expect(statusFor(body, "openalex")["status"]).toBe("upstream_unavailable");
        expect(statusFor(body, "europepmc")["status"]).toBe("ok");
      },
      {
        router: (url) => {
          if (url.hostname === "api.openalex.org") return text("down", 500);
          return routeFixture(url);
        },
      },
    );
  });

  it("searches authors and lists their works", async () => {
    await withSession(async ({ client }) => {
      const authors = data(await callTool(client, "search_authors", { query: "Grace Hopper" }));
      const list = authors["authors"];
      if (!Array.isArray(list)) throw new Error("authors");
      const author = asRecord(list[0]);
      expect(author["openalexId"]).toBe("A555");
      expect(author["orcid"]).toBe("0000-0001-5109-3700");
      expect(author["worksCount"]).toBe(40);
      expect(author["hIndex"]).toBe(12);
      expect(author["affiliations"]).toEqual(["US Navy"]);

      const works = data(
        await callTool(client, "get_author_works", { openalexId: "A555", limit: 5 }),
      );
      expect(papersOf(works)[0]?.["title"]).toBe("Compiler Notes");

      const bad = await callTool(client, "get_author_works", { openalexId: "nope" });
      expect(bad.isError).toBe(true);
      expect(bad.text).toContain("[invalid-input]");
    });
  });

  it("returns licensed Europe PMC full text and refuses the other cases", async () => {
    await withSession(async ({ client, hits }) => {
      const opened = data(await callTool(client, "get_full_text", { pmcid: "PMC101" }));
      expect(opened["fullText"]).toContain("Hello world");
      expect(opened["license"]).toBe("cc by");
      expect(opened["truncated"]).toBe(false);
      expect(hits.some((hit) => hit.url.includes("fullTextXML"))).toBe(true);

      const closedHits = hits.length;
      const closed = data(await callTool(client, "get_full_text", { pmcid: "PMC102" }));
      expect(closed["fullText"]).toBeNull();
      expect(String(closed["reason"])).toContain("open licence");
      expect(closed["license"]).toBe("all-rights-reserved");
      expect(hits.slice(closedHits).some((hit) => hit.url.includes("fullTextXML"))).toBe(false);

      const notOpen = data(await callTool(client, "get_full_text", { pmcid: "PMC103" }));
      expect(notOpen["fullText"]).toBeNull();
      expect(String(notOpen["reason"])).toContain("open-access");

      const beforeArxiv = hits.length;
      const arxiv = data(await callTool(client, "get_full_text", { arxivId: "2401.00001v2" }));
      expect(arxiv["fullText"]).toBeNull();
      expect(String(arxiv["reason"])).toContain("arXiv");
      expect(asRecord(arxiv["urls"])["abs"]).toBe("https://arxiv.org/abs/2401.00001");
      expect(asRecord(arxiv["urls"])["pdfUrl"]).toBe("https://arxiv.org/pdf/2401.00001");
      expect(hits.slice(beforeArxiv)).toHaveLength(0);
    });
  });

  it("caps licensed full text", async () => {
    await withSession(
      async ({ client }) => {
        const body = data(await callTool(client, "get_full_text", { pmcid: "PMC101" }));
        expect(body["truncated"]).toBe(true);
        expect(String(body["fullText"]).length).toBe(80_000);
        expect(body["license"]).toBe("cc by");
      },
      {
        router: (url) => {
          if (url.pathname.endsWith("/fullTextXML")) {
            return xml(`<article><body><p>${"word ".repeat(20_000)}</p></body></article>`);
          }
          return routeFixture(url);
        },
      },
    );
  });

  it("exports BibTeX and RIS from supplied metadata or a resolved DOI", async () => {
    await withSession(async ({ client, hits }) => {
      const offline = data(
        await callTool(client, "export_citation", {
          format: "bibtex",
          title: "A {Weird} Title",
          authors: [{ name: "Ada Lovelace" }],
          year: 2020,
        }),
      );
      expect(hits).toHaveLength(0);
      expect(String(offline["citation"])).toContain("@article{");
      expect(String(offline["citation"])).toContain("A \\{Weird\\} Title");

      const ris = data(
        await callTool(client, "export_citation", {
          format: "ris",
          title: "A Title",
          year: 2020,
        }),
      );
      expect(String(ris["citation"])).toContain("TY  - JOUR");
      expect(String(ris["citation"])).toContain("ER  -");

      const fromDoi = data(
        await callTool(client, "export_citation", { format: "bibtex", doi: "10.1000/transformer" }),
      );
      expect(String(fromDoi["citation"])).toContain("doi = {10.1000/transformer}");
      expect(hits.length).toBeGreaterThan(0);

      const missing = await callTool(client, "export_citation", { format: "ris" });
      expect(missing.isError).toBe(true);
      expect(missing.text).toContain("[invalid-input]");
    });
  });

  it("serves a cached lookup without spending the inbound limiter again", async () => {
    await withSession(
      async ({ client, hits }) => {
        const first = await callTool(client, "search_source", {
          source: "crossref",
          query: "attention",
        });
        const second = await callTool(client, "search_source", {
          source: "crossref",
          query: "attention",
        });
        expect(first.isError).toBe(false);
        expect(second.text).toBe(first.text);
        expect(hits).toHaveLength(1);
      },
      { perMinute: "1", cacheTtlSec: "60" },
    );
  });

  it("returns the inbound rate limit when the local window is full", async () => {
    await withSession(
      async ({ client }) => {
        const first = await callTool(client, "search_source", { source: "doaj", query: "one" });
        const second = await callTool(client, "search_source", { source: "doaj", query: "two" });
        expect(first.isError).toBe(false);
        expect(second.isError).toBe(true);
        expect(second.text).toContain("[rate-limited]");
      },
      { perMinute: "1", cacheTtlSec: "0" },
    );
  });
});

describe("upstream politeness", () => {
  it("honors Retry-After and does not retry a validation error", async () => {
    await withSession(
      async ({ client, hits, sleeps }) => {
        const ok = await callTool(client, "search_source", { source: "crossref", query: "attention" });
        expect(ok.isError).toBe(false);
        expect(hits).toHaveLength(2);
        expect(sleeps).toContain(2000);
      },
      {
        router: (() => {
          let calls = 0;
          return (url: URL) => {
            calls += 1;
            if (calls === 1) return text("slow", 429, { "retry-after": "2" });
            return routeFixture(url);
          };
        })(),
      },
    );

    await withSession(
      async ({ client, hits }) => {
        const bad = await callTool(client, "search_source", { source: "crossref", query: "attention" });
        expect(bad.isError).toBe(true);
        expect(bad.text).toContain("[upstream]");
        expect(bad.text).toContain("crossref");
        expect(bad.text).toContain("400");
        expect(hits).toHaveLength(1);
      },
      { router: () => text("bad query", 400) },
    );
  });

  it("retries 500 and network timeouts, and does not retry an HTML page or a redirect", async () => {
    await withSession(
      async ({ client, hits, sleeps }) => {
        const ok = await callTool(client, "search_source", { source: "doaj", query: "attention" });
        expect(ok.isError).toBe(false);
        expect(hits).toHaveLength(3);
        expect(sleeps).toEqual([100, 200]);
      },
      {
        router: (() => {
          let calls = 0;
          return (url: URL) => {
            calls += 1;
            if (calls < 3) return text("unavailable", 500);
            return routeFixture(url);
          };
        })(),
      },
    );

    await withSession(
      async ({ client, hits }) => {
        const timed = await callTool(client, "search_source", { source: "doaj", query: "attention" });
        expect(timed.isError).toBe(true);
        expect(timed.text).toContain("[timeout]");
        expect(timed.text).toContain("doaj");
        expect(timed.text).not.toMatch(/at src\//);
        expect(hits).toHaveLength(3);
      },
      {
        router: () => {
          const error = new Error("The operation was aborted");
          error.name = "TimeoutError";
          throw error;
        },
      },
    );

    await withSession(
      async ({ client, hits }) => {
        const html = await callTool(client, "search_source", { source: "doaj", query: "attention" });
        expect(html.isError).toBe(true);
        expect(html.text).toContain("HTML");
        expect(hits).toHaveLength(1);
      },
      { router: () => xml("<!doctype html><html></html>") },
    );

    await withSession(
      async ({ client, hits }) => {
        const redirected = await callTool(client, "search_source", {
          source: "crossref",
          query: "attention",
        });
        expect(redirected.isError).toBe(true);
        expect(redirected.text).toContain("refusing a redirect");
        expect(hits).toHaveLength(1);
        expect(hits[0]?.url).not.toContain("/pdf");
      },
      {
        router: () => text("", 302, { location: "https://arxiv.org/pdf/2401.00001" }),
      },
    );
  });

  it("tightens the Crossref interval from X-Rate-Limit headers", async () => {
    await withSession(
      async ({ client, hits, sleeps }) => {
        const first = await callTool(client, "search_source", { source: "crossref", query: "one" });
        const second = await callTool(client, "search_source", { source: "crossref", query: "two" });
        expect(first.isError).toBe(false);
        expect(second.isError).toBe(false);
        expect(hits).toHaveLength(2);
        expect(hits[1]?.at ?? 0).toBeGreaterThanOrEqual(5000);
        expect(sleeps.some((ms) => ms >= 5000)).toBe(true);
      },
      {
        router: async (url) => {
          const response = routeFixture(url);
          const body = await response.text();
          const headers = new Headers(response.headers);
          headers.set("x-rate-limit-limit", "1");
          headers.set("x-rate-limit-interval", "5s");
          return new Response(body, { status: response.status, headers });
        },
      },
    );
  });

  it("refuses a PDF URL before fetch", async () => {
    let fetched = false;
    const runtime = createRuntime(loadConfig({}, []), {
      fetchImpl: () => {
        fetched = true;
        return Promise.resolve(text("nope", 200));
      },
    });
    await expect(
      runtime.context.upstream.getText({
        source: "arxiv",
        url: "https://export.arxiv.org/api/pdf/2401.00001",
        accept: "application/pdf",
        scheduler: runtime.context.schedulers.arxiv,
        cacheTtlSec: 0,
      }),
    ).rejects.toThrow(/PDF/);
    expect(fetched).toBe(false);
  });
});
