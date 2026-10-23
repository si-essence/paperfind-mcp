# paperfind-mcp (Paperfind)

Paperfind is a read-only Model Context Protocol connector for academic paper metadata and links. It searches arXiv, Crossref, OpenAlex, Europe PMC, PubMed, and DOAJ, and it asks Unpaywall for open-access locations by DOI. Every tool is read-only. The server speaks stdio, and it can serve stateless Streamable HTTP on `127.0.0.1` only.

A paper record carries normalized ids (DOI in lowercase without a `https://doi.org/` prefix, plus arXiv, PMID, PMCID, OpenAlex, and DOAJ ids when a source provides them), title, authors, year, venue, abstract, landing and PDF links, open-access fields, citation count, and the sources that returned the record. Search merges duplicates that share a DOI, or that share a normalized title and year when their strong ids do not conflict. The richest abstract wins. An abstract without a copyright note beats a longer abstract that carries one. Source lists and ids are unioned.

**Connects to:** public scholarly APIs (arXiv, Crossref, OpenAlex, Europe PMC, PubMed / NCBI E-utilities, DOAJ, and Unpaywall). Keys for OpenAlex and NCBI are optional.

The npm package, binary, and User-Agent name are `papers`.

By Issah Abubakari ([@si-essence](https://github.com/si-essence)). Also listed on [Bot Essentials](https://bot-essentials.netlify.app).

## Requirements

- Node.js 20 or newer (CI uses Node.js 22)
- npm

## Tools

Limits default to 5 and max out at 25. Page defaults to 1 and maxes out at 200. `yearFrom` must be less than or equal to `yearTo`.

| Tool               | Input                                                                                                               | Output                                                                                                                                                                                                                         |
| ------------------ | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `search_papers`    | `query`. Optional `limit`, `yearFrom`, `yearTo`, `openAccessOnly`, `sources`.                                       | Deduplicated papers and a status per source (`ok`, an error code, or `skipped`). Default sources are Crossref, OpenAlex, Europe PMC, PubMed, and DOAJ. arXiv runs only when named. One failed source does not fail the call.   |
| `search_source`    | `source` plus the search fields above. `arxivCategory` is optional.                                                 | Papers from that source and one status. A failure fails this call.                                                                                                                                                             |
| `get_paper_by_doi` | `doi`                                                                                                               | One merged paper from Crossref and OpenAlex, plus Unpaywall locations when that lookup succeeds, and a status for each upstream.                                                                                               |
| `get_paper`        | `idType` of `arxiv`, `pmid`, `pmcid`, or `openalex`, and `id`.                                                      | One paper from the matching source. DOI resolution stays on `get_paper_by_doi`.                                                                                                                                                |
| `find_open_access` | `doi`                                                                                                               | `isOa`, `best`, `locations` (url, pdf link, licence, version, host type), and statuses. OpenAlex fills in when Unpaywall fails or has no best location.                                                                        |
| `get_citations`    | One of `doi`, `pmid`, `pmcid`, `openalexId`. Optional `page`, `limit`.                                              | Citing works from OpenAlex and Europe PMC, plus statuses.                                                                                                                                                                      |
| `get_references`   | Same as citations.                                                                                                  | Referenced works from OpenAlex, Crossref when a DOI is present, and Europe PMC, plus statuses.                                                                                                                                 |
| `search_authors`   | `query`. Optional `limit`.                                                                                          | OpenAlex authors with ORCID, affiliations, works count, and h-index when present.                                                                                                                                              |
| `get_author_works` | `openalexId` such as `A123`. Optional `page`, `limit`.                                                              | Papers for that author.                                                                                                                                                                                                        |
| `get_full_text`    | One of `doi`, `pmid`, `pmcid`, `arxivId`.                                                                           | Plain text and the licence when Europe PMC says the record is open access and the licence is open. Otherwise links or ids and a reason. arXiv never returns text.                                                              |
| `list_sources`     | None.                                                                                                               | Each source, whether it is searchable, the rate this process enforces, the terms link, auth, and the env names `PAPERS_CONTACT_EMAIL`, `OPENALEX_API_KEY`, and `NCBI_API_KEY` with a boolean `set`. Values are never returned. |
| `export_citation`  | `format` of `bibtex` or `ris`. Provide `title` (and optional authors, year, venue, abstract, doi) or a `doi` alone. | A citation string. A DOI without a title is resolved first.                                                                                                                                                                    |

Tool errors use these prefixes and name the source: `[invalid-input]`, `[not-found]`, `[rate-limited]`, `[upstream]`, `[timeout]`, `[config]`. Messages do not include stack traces or secret values.

## Setup

From a clone of this repository:

```bash
npm ci
npm run ci          # typecheck, lint, test, build
npm start           # stdio
npm run start:http  # http://127.0.0.1:3000/mcp and /health
node scripts/live-check.mjs   # optional, calls the real public APIs
```

Copy `.env.example` and export the variables, or set them in the client config.

```json
{
  "mcpServers": {
    "papers": {
      "command": "node",
      "args": ["/path/to/paperfind-mcp/dist/index.js"],
      "env": {
        "PAPERS_CONTACT_EMAIL": "contact@example.com"
      }
    }
  }
}
```

`OPENALEX_API_KEY` and `NCBI_API_KEY` are optional. Leave them unset for keyless limits. Do not log them.

Docker binds HTTP with no authentication. Keep the port on localhost.

```bash
docker build -t papers .
docker run -p 3000:3000 -e PAPERS_CONTACT_EMAIL=contact@example.com papers
```

The image sets `PAPERS_CONTACT_EMAIL=contact@example.com`. Override it with an address you control. Do not bake a personal address or an API key into the image.

## Environment

| Variable               | Default               | Role                                                                                                                               |
| ---------------------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `PAPERS_CONTACT_EMAIL` | `contact@example.com` | User-Agent mailto, and the email sent to Crossref, PubMed, and Unpaywall. Must look like an email and must not contain an API key. |
| `OPENALEX_API_KEY`     | unset                 | Optional bearer token for OpenAlex. At least 8 characters. Never printed.                                                          |
| `NCBI_API_KEY`         | unset                 | Optional NCBI `api_key` query parameter. At least 8 characters. Never printed.                                                     |
| `PAPERS_PER_MINUTE`    | `60`                  | Inbound sliding window. Cache hits do not spend it.                                                                                |
| `PAPERS_CACHE_TTL_SEC` | `60`                  | TTL for a successful redacted upstream body. `0` disables the cache.                                                               |
| `PAPERS_TIMEOUT_MS`    | `20000`               | Per-attempt upstream timeout.                                                                                                      |
| `MCP_TRANSPORT`        | `stdio`               | `stdio` or `http`. `--http` forces HTTP.                                                                                           |
| `PORT`                 | `3000`                | HTTP port. The listener is `127.0.0.1`.                                                                                            |

Invalid values are reported by field name and issue code. The rejected value is not included in the error.

The User-Agent is `papers/0.1.0 (mailto:<PAPERS_CONTACT_EMAIL>)`.

## Sources and terms

Checked on 2026-10-17. The rate column is what this process enforces.

| Source     | What we use                                                                  | Data licence                                                                               | Rate we enforce                                                                        | Auth                                         | What we never do                                                     | Terms                                                              |
| ---------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- | -------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------ |
| arXiv      | Atom search and id lookup. Metadata and links.                               | Metadata is CC0.                                                                           | 1 request every 3 seconds, one at a time.                                              | None.                                        | Fetch or return PDF or source bytes. Imply arXiv endorsement.        | https://info.arxiv.org/help/api/tou.html                           |
| Crossref   | Works search, DOI lookup, deposited references.                              | Most metadata is free of copyright. Some abstracts are publisher copyright and are marked. | 3 requests/s in the polite pool, then slower when `X-Rate-Limit` headers are stricter. | None. `mailto` is `PAPERS_CONTACT_EMAIL`.    | Treat a copyrighted abstract as a licence to reuse it.               | https://www.crossref.org/documentation/retrieve-metadata/rest-api/ |
| OpenAlex   | Works, authors, citations, references, open-access fields.                   | Data is CC0. The API is a metered service.                                                 | 10 requests/s keyless, 30 requests/s when a key is set.                                | Optional `OPENALEX_API_KEY` bearer token.    | Call the key-signup endpoint or invent an email.                     | https://help.openalex.org/access/pricing/                          |
| Europe PMC | Search, citations, references, and full text XML for the open-access subset. | API use is a sanctioned channel. Full text follows the article licence.                    | 5 requests/s.                                                                          | None.                                        | Return full text unless `isOpenAccess` is Y and the licence is open. | https://europepmc.org/RestfulWebService                            |
| PubMed     | E-utilities esearch and efetch.                                              | Metadata via NCBI. Abstracts may be publisher copyright and are marked.                    | 3 requests/s, or 10 requests/s when `NCBI_API_KEY` is set.                             | Optional `api_key`, plus `tool` and `email`. | Present an abstract as a licence to reuse it.                        | https://www.ncbi.nlm.nih.gov/home/about/policies/                  |
| DOAJ       | Article search.                                                              | Article metadata from the API is CC0.                                                      | 2 requests/s.                                                                          | None for public search.                      | Copy DOAJ website content.                                           | https://doaj.org/terms/                                            |
| Unpaywall  | DOI open-access location lookup only. Enrichment, not a search source.       | Location links. The files they point at keep their own licences.                           | 1 request/s.                                                                           | `email` from `PAPERS_CONTACT_EMAIL`.         | Use Unpaywall as a paper search. Download PDF bytes.                 | https://help.openalex.org/access/unpaywall/                        |

An open licence here means a Creative Commons licence (the string starts with `cc` or names creativecommons.org), CC0, or public domain. The full-text cap is 80,000 characters. The licence string is returned with any text.

## Excluded sources

Semantic Scholar is excluded. Its API licence forbids repackaging, selling, renting, leasing, lending, distributing, or sublicensing the API, some of the data is CC BY-NC, and Ai2 ships an official MCP. Google Scholar is excluded because it has no API for this use and scraping breaks its terms. Sci-Hub and LibGen are excluded because they distribute texts without a licence to do so.

## Attribution

Metadata comes from Crossref. OpenAlex data is CC0. arXiv metadata is CC0. Thank you to arXiv for use of its open access interoperability. Europe PMC records are used through its REST API. This connector uses NCBI E-utilities from the National Library of Medicine (NLM). NLM is not responsible for this project and does not endorse it. DOAJ article metadata is CC0. Unpaywall locations come from the Unpaywall API, now documented by OpenAlex. None of these providers endorse this project.

## Limits and caveats

- Crossref does not publish a fixed numeric polite-pool rate. This connector starts at 334 ms between Crossref calls, only lengthens that gap when `X-Rate-Limit-Limit` and `X-Rate-Limit-Interval` ask for a slower pace, and honours `Retry-After` on HTTP 429.
- `contact@example.com` is a placeholder. Unpaywall rejects it with HTTP 422 and asks for the caller's own email. In that case `find_open_access` reports Unpaywall as unavailable and still returns the OpenAlex location. Set `PAPERS_CONTACT_EMAIL` to an address you control. When both lookups fail, the tool returns a reason and per-source statuses. Upstream error text replaces `http` and `https` URLs with `[url]`.
- Unpaywall is used for the DOI lookup `GET /v2/{doi}` only. Paper search goes to OpenAlex.
- NCBI E-utilities require `tool` and `email` and allow 3 requests per second without a key. With `NCBI_API_KEY` set, this connector allows 10 requests per second.
- Europe PMC calls are capped at 5 requests per second.
- DOAJ's API docs allow a burst of five requests if the average stays at 2 per second. This connector spaces every DOAJ call by 500 ms and does not burst.
- OpenAlex's current authentication page says 10 requests per second with no key and 30 with a free key. Semantic search is 1 request per second. This connector does not call semantic search, and it does not sign up for a key.
- Retries run on 429, 5xx, timeout, and network errors, with bounded backoff and jitter, up to 3 attempts. Other 4xx responses, HTML bodies, and redirects are not retried. Redirects are refused, including a redirect toward a PDF.
- The cache and the inbound window live in the process. They disappear on exit.
- `search_source` and `get_paper` report a single source, so a failure of that source fails the call. `get_paper_by_doi` returns not found when both Crossref and OpenAlex miss.
- Year filters drop records that have no year. Open-access filters drop records the source did not mark open.
- Title dedupe lowercases, strips punctuation and diacritics, and collapses whitespace. Two different DOIs are never merged.

## Running the tests

The tests use mocked upstream responses. They need no API key and make no network calls to the paper sources.

```bash
npm ci
npm test        # unit and tool tests (vitest)
npm run ci      # typecheck, lint, tests, and build
```

At the time of this commit, `npm test` reports 49 passing tests.

## Author

Issah Abubakari ([@si-essence](https://github.com/si-essence)).

This connector is also listed on [Bot Essentials](https://bot-essentials.netlify.app).

## Licence

MIT. See [LICENSE](LICENSE). The data licences above are separate from the MIT licence on this code.
