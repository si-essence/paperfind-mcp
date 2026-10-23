import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { toolDescription, toolName } from "./brand.js";
import { CONNECTOR_NAME, CONNECTOR_VERSION } from "./constants.js";
import {
  exportCitationTool,
  findOpenAccess,
  getAuthorWorks,
  getCitations,
  getFullText,
  getPaper,
  getPaperByDoi,
  getReferences,
  listSources,
  searchAuthors,
  searchPapers,
  searchSource,
} from "./operations.js";
import type { Runtime } from "./runtime.js";
import {
  exportCitationInput,
  findOpenAccessInput,
  getAuthorWorksInput,
  getCitationsInput,
  getFullTextInput,
  getPaperByDoiInput,
  getPaperInput,
  getReferencesInput,
  listSourcesInput,
  searchAuthorsInput,
  searchPapersInput,
  searchSourceInput,
} from "./schemas.js";
import { READ_ONLY_REMOTE, registerConnectorTool, type ToolAnnotations } from "./tools.js";

const READ_ONLY: ToolAnnotations = { ...READ_ONLY_REMOTE, idempotentHint: true };

export function createServer(runtime: Runtime): McpServer {
  const server = new McpServer({ name: CONNECTOR_NAME, version: CONNECTOR_VERSION });
  const ctx = { secrets: runtime.secrets, logger: runtime.logger };
  const source = runtime.context;

  registerConnectorTool(
    server,
    {
      name: toolName("search_papers"),
      description: toolDescription(
        "Search Crossref, OpenAlex, Europe PMC, PubMed, and DOAJ. arXiv is included only when named in sources. Returns deduplicated papers and a status for each source. One failed source does not fail the call.",
      ),
      inputSchema: searchPapersInput,
      annotations: READ_ONLY,
      handler: (args) => searchPapers(source, args),
    },
    ctx,
  );
  registerConnectorTool(
    server,
    {
      name: toolName("search_source"),
      description: toolDescription(
        "Search one named source. Supports source-specific options such as an arXiv category. Returns papers from that source only.",
      ),
      inputSchema: searchSourceInput,
      annotations: READ_ONLY,
      handler: (args) => searchSource(source, args),
    },
    ctx,
  );
  registerConnectorTool(
    server,
    {
      name: toolName("get_paper_by_doi"),
      description: toolDescription(
        "Resolve one DOI through Crossref and OpenAlex, then add Unpaywall open-access locations when that lookup succeeds. Returns the merged paper and a status for each upstream.",
      ),
      inputSchema: getPaperByDoiInput,
      annotations: READ_ONLY,
      handler: (args) => getPaperByDoi(source, args),
    },
    ctx,
  );
  registerConnectorTool(
    server,
    {
      name: toolName("get_paper"),
      description: toolDescription(
        "Fetch one paper by arXiv id, PMID, PMCID, or OpenAlex work id. DOI lookup stays on get_paper_by_doi because that path merges several sources.",
      ),
      inputSchema: getPaperInput,
      annotations: READ_ONLY,
      handler: (args) => getPaper(source, args),
    },
    ctx,
  );
  registerConnectorTool(
    server,
    {
      name: toolName("find_open_access"),
      description: toolDescription(
        "Look up open-access locations for a DOI. Uses Unpaywall first and falls back to OpenAlex when Unpaywall fails. Returns links and licences, never PDF bytes.",
      ),
      inputSchema: findOpenAccessInput,
      annotations: READ_ONLY,
      handler: (args) => findOpenAccess(source, args),
    },
    ctx,
  );
  registerConnectorTool(
    server,
    {
      name: toolName("get_citations"),
      description: toolDescription(
        "List works that cite a paper, using OpenAlex and Europe PMC. Paginated. A source that cannot answer is skipped. A source that fails is reported and the other results are still returned.",
      ),
      inputSchema: getCitationsInput,
      annotations: READ_ONLY,
      handler: (args) => getCitations(source, args),
    },
    ctx,
  );
  registerConnectorTool(
    server,
    {
      name: toolName("get_references"),
      description: toolDescription(
        "List works referenced by a paper, using OpenAlex, Crossref deposits, and Europe PMC. Paginated. Partial source failure does not drop the sources that succeeded.",
      ),
      inputSchema: getReferencesInput,
      annotations: READ_ONLY,
      handler: (args) => getReferences(source, args),
    },
    ctx,
  );
  registerConnectorTool(
    server,
    {
      name: toolName("search_authors"),
      description: toolDescription(
        "Search OpenAlex authors. Returns ORCID, affiliations, works count, and h-index when OpenAlex provides them.",
      ),
      inputSchema: searchAuthorsInput,
      annotations: READ_ONLY,
      handler: (args) => searchAuthors(source, args),
    },
    ctx,
  );
  registerConnectorTool(
    server,
    {
      name: toolName("get_author_works"),
      description: toolDescription(
        "List works for one OpenAlex author id. The id looks like A123. Results are paginated.",
      ),
      inputSchema: getAuthorWorksInput,
      annotations: READ_ONLY,
      handler: (args) => getAuthorWorks(source, args),
    },
    ctx,
  );
  registerConnectorTool(
    server,
    {
      name: toolName("get_full_text"),
      description: toolDescription(
        "Return plain text only for an Europe PMC open-access record that carries an open licence. Otherwise return links and the reason. Never returns arXiv full text or PDF bytes.",
      ),
      inputSchema: getFullTextInput,
      annotations: READ_ONLY,
      handler: (args) => getFullText(source, args),
    },
    ctx,
  );
  registerConnectorTool(
    server,
    {
      name: toolName("list_sources"),
      description: toolDescription(
        "List sources, whether each one is searchable, the rate limit this connector enforces, terms links, and which environment variable names are set. Values are never returned.",
      ),
      inputSchema: listSourcesInput,
      annotations: READ_ONLY,
      handler: () => Promise.resolve(listSources(source)),
    },
    ctx,
  );
  registerConnectorTool(
    server,
    {
      name: toolName("export_citation"),
      description: toolDescription(
        "Export BibTeX or RIS from supplied metadata. When title is omitted, resolve the DOI first and export the merged record.",
      ),
      inputSchema: exportCitationInput,
      annotations: READ_ONLY,
      handler: (args) => exportCitationTool(source, args),
    },
    ctx,
  );
  return server;
}
