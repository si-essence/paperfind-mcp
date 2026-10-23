import type { Config } from "./config.js";
import type { UpstreamId } from "./paper.js";

export interface SourcePolicy {
  id: UpstreamId;
  search: boolean;
  minIntervalMs: number;
  maxConcurrent: 1;
  rate: string;
  termsUrl: string;
  auth: string;
  never: string;
}

const THREE_SECONDS = 3_000;

export function sourcePolicies(config: Pick<Config, "openAlexApiKey" | "ncbiApiKey">): SourcePolicy[] {
  const openAlexPerSecond = config.openAlexApiKey === undefined ? 10 : 30;
  const ncbiPerSecond = config.ncbiApiKey === undefined ? 3 : 10;
  return [
    {
      id: "arxiv",
      search: true,
      minIntervalMs: THREE_SECONDS,
      maxConcurrent: 1,
      rate: "1 request every 3s, one at a time",
      termsUrl: "https://info.arxiv.org/help/api/tou.html",
      auth: "none",
      never: "Never fetch or return arXiv PDF or source bytes. Links only.",
    },
    {
      id: "crossref",
      search: true,
      minIntervalMs: 334,
      maxConcurrent: 1,
      rate: "3 requests/s polite pool, slowed further when X-Rate-Limit headers are stricter",
      termsUrl: "https://www.crossref.org/documentation/retrieve-metadata/rest-api/",
      auth: "none. mailto is PAPERS_CONTACT_EMAIL",
      never: "Do not treat publisher-copyright abstracts as a granted licence.",
    },
    {
      id: "openalex",
      search: true,
      minIntervalMs: Math.ceil(1000 / openAlexPerSecond),
      maxConcurrent: 1,
      rate: `${openAlexPerSecond} requests/s (${config.openAlexApiKey === undefined ? "keyless" : "key set"})`,
      termsUrl: "https://help.openalex.org/access/pricing/",
      auth: "optional OPENALEX_API_KEY as a bearer token",
      never: "Do not call the OpenAlex API-key signup endpoint or invent an email.",
    },
    {
      id: "europepmc",
      search: true,
      minIntervalMs: 200,
      maxConcurrent: 1,
      rate: "5 requests/s",
      termsUrl: "https://europepmc.org/RestfulWebService",
      auth: "none",
      never: "Full text only for the open-access subset with a Creative Commons licence.",
    },
    {
      id: "pubmed",
      search: true,
      minIntervalMs: Math.ceil(1000 / ncbiPerSecond),
      maxConcurrent: 1,
      rate: `${ncbiPerSecond} requests/s (${config.ncbiApiKey === undefined ? "no key" : "NCBI_API_KEY set"})`,
      termsUrl: "https://www.ncbi.nlm.nih.gov/home/about/policies/",
      auth: "optional NCBI_API_KEY query parameter, plus tool and email",
      never: "Do not present PubMed abstracts as a licence to reuse them.",
    },
    {
      id: "doaj",
      search: true,
      minIntervalMs: 500,
      maxConcurrent: 1,
      rate: "2 requests/s",
      termsUrl: "https://doaj.org/terms/",
      auth: "none for public search",
      never: "Do not copy DOAJ website content. Article metadata from the API is CC0.",
    },
    {
      id: "unpaywall",
      search: false,
      minIntervalMs: 1000,
      maxConcurrent: 1,
      rate: "1 request/s",
      termsUrl: "https://help.openalex.org/access/unpaywall/",
      auth: "email query parameter from PAPERS_CONTACT_EMAIL",
      never: "DOI lookup only. No Unpaywall search endpoint. No PDF bytes.",
    },
  ];
}

export function policyFor(
  config: Pick<Config, "openAlexApiKey" | "ncbiApiKey">,
  id: UpstreamId,
): SourcePolicy {
  const found = sourcePolicies(config).find((policy) => policy.id === id);
  if (found === undefined) {
    throw new Error(`missing policy ${id}`);
  }
  return found;
}
