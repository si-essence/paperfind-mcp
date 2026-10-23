export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

export function xml(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "application/xml" },
  });
}

export function text(body: string, status: number, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers });
}

const ARXIV_FEED = `<?xml version="1.0"?>
<feed>
  <entry>
    <id>https://arxiv.org/abs/2401.00001v2</id>
    <title>Attention  Is   All You Need</title>
    <published>2024-01-02T00:00:00Z</published>
    <summary>A transformer abstract from the preprint.</summary>
    <author><name>Ashish Vaswani</name></author>
    <doi>10.1000/TRANSFORMER</doi>
    <link rel="alternate" type="text/html" href="https://arxiv.org/abs/2401.00001"/>
    <link title="pdf" type="application/pdf" href="https://arxiv.org/pdf/2401.00001"/>
    <journal_ref>NeurIPS</journal_ref>
    <weird>ignored</weird>
  </entry>
</feed>`;

const PUBMED_XML = `<?xml version="1.0"?>
<PubmedArticleSet>
  <PubmedArticle>
    <MedlineCitation>
      <PMID>12345</PMID>
      <Article>
        <ArticleTitle>PubMed Attention Note</ArticleTitle>
        <Abstract>
          <AbstractText Label="BACKGROUND">Cells grow.</AbstractText>
        </Abstract>
        <AuthorList>
          <Author>
            <LastName>Hopper</LastName>
            <ForeName>Grace</ForeName>
            <Identifier Source="ORCID">0000-0001-5109-3700</Identifier>
          </Author>
        </AuthorList>
        <Journal>
          <Title>Nature</Title>
          <JournalIssue><PubDate><Year>2020</Year></PubDate></JournalIssue>
        </Journal>
      </Article>
    </MedlineCitation>
    <PubmedData>
      <ArticleIdList>
        <ArticleId IdType="doi">10.2000/PubMed</ArticleId>
        <ArticleId IdType="pmc">PMC42</ArticleId>
      </ArticleIdList>
    </PubmedData>
  </PubmedArticle>
</PubmedArticleSet>`;

const transformerWork = {
  DOI: "HTTPS://doi.org/10.1000/Transformer",
  title: ["Attention Is All You Need"],
  author: [
    {
      given: "Ashish",
      family: "Vaswani",
      ORCID: "https://orcid.org/0000-0002-1825-0097",
    },
  ],
  issued: { "date-parts": [[2024, 1, 2]] },
  "container-title": ["NeurIPS"],
  abstract: "<jats:p>A much longer published abstract about transformers and attention.</jats:p>",
  URL: "https://doi.org/10.1000/transformer",
  "is-referenced-by-count": 12,
  license: [{ URL: "https://creativecommons.org/licenses/by/4.0" }],
  link: [{ URL: "https://publisher.example/paper.pdf", "content-type": "application/pdf" }],
  mesh: ["ignored"],
};

const crossrefRefs = [
  {
    "article-title": "Crossref Ref One",
    DOI: "10.7000/ref-one",
    year: "2019",
    author: "Ref Author",
    "journal-title": "Notes",
  },
  { "article-title": "Crossref Ref Two", DOI: "10.7000/ref-two", year: "2018" },
];

const openAlexWork = {
  id: "https://openalex.org/W123",
  display_name: "Attention Is All You Need",
  publication_year: 2024,
  publication_date: "2024-01-02",
  cited_by_count: 99,
  doi: "doi:10.1000/TRANSFORMER",
  authorships: [
    {
      author: {
        display_name: "Ashish Vaswani",
        orcid: "https://orcid.org/0000-0002-1825-0097",
      },
    },
  ],
  primary_location: {
    landing_page_url: "https://doi.org/10.1000/transformer",
    source: { display_name: "NeurIPS", type: "journal" },
  },
  best_oa_location: {
    pdf_url: "https://oa.example/paper.pdf",
    license: "cc-by",
    is_oa: true,
    source: { display_name: "NeurIPS", type: "repository" },
  },
  open_access: { is_oa: true, oa_url: "https://oa.example/paper.pdf" },
  abstract_inverted_index: { Short: [0], OA: [1], abstract: [2] },
  extra_unknown: { keep: true },
};

function decoded(url: URL): string {
  try {
    return decodeURIComponent(`${url.pathname}${url.search}`);
  } catch {
    return `${url.pathname}${url.search}`;
  }
}

function europeRecord(pmcid: string, license: string, oa: "Y" | "N", title: string): unknown {
  return {
    resultList: {
      result: [
        {
          id: pmcid.replace(/^PMC/i, ""),
          pmcid,
          title,
          isOpenAccess: oa,
          license,
          authorString: "A Author",
          pubYear: "2020",
        },
      ],
    },
  };
}

function referencedWorks(filter: string): unknown {
  const results: unknown[] = [];
  if (filter.includes("W900")) {
    results.push({
      id: "https://openalex.org/W900",
      display_name: "First Reference",
      publication_year: 2016,
    });
  }
  if (filter.includes("W901")) {
    results.push({
      id: "https://openalex.org/W901",
      display_name: "Second Reference",
      publication_year: 2015,
    });
  }
  return { results };
}

export function routeFixture(url: URL): Response {
  const host = url.hostname;
  const path = url.pathname;
  const raw = decoded(url);

  if (host === "export.arxiv.org") {
    if (url.searchParams.get("id_list") === "9999.99999") return xml("<feed></feed>");
    return xml(ARXIV_FEED);
  }

  if (host === "api.crossref.org") {
    if (raw.includes("10.9000/missing")) return text("missing", 404);
    if (path === "/works") {
      const query = url.searchParams.get("query") ?? "";
      if (query.includes("closed")) {
        return json({
          status: "ok",
          message: {
            items: [
              {
                DOI: "10.4000/closed",
                title: ["Closed Access Paper"],
                issued: { "date-parts": [[2020]] },
                URL: "https://doi.org/10.4000/closed",
                "is-referenced-by-count": 1,
              },
            ],
          },
        });
      }
      if (query.includes("split")) {
        return json({
          status: "ok",
          message: {
            items: [
              {
                DOI: "10.1000/alpha",
                title: ["Same Title"],
                issued: { "date-parts": [[2020]] },
                URL: "https://doi.org/10.1000/alpha",
              },
            ],
          },
        });
      }
      return json({ status: "ok", message: { items: [transformerWork] } });
    }
    return json({ status: "ok", message: { ...transformerWork, reference: crossrefRefs } });
  }

  if (host === "api.openalex.org") {
    if (path.startsWith("/authors")) {
      return json({
        results: [
          {
            id: "https://openalex.org/A555",
            display_name: "Grace Hopper",
            orcid: "https://orcid.org/0000-0001-5109-3700",
            works_count: 40,
            summary_stats: { h_index: 12 },
            last_known_institutions: [{ display_name: "US Navy" }],
          },
        ],
      });
    }
    if (raw.includes("10.9000/missing")) return text("missing", 404);
    if (path.startsWith("/works/")) {
      const select = url.searchParams.get("select") ?? "";
      if (select.includes("referenced_works")) {
        return json({
          id: "https://openalex.org/W123",
          referenced_works: ["https://openalex.org/W900", "https://openalex.org/W901"],
        });
      }
      return json(openAlexWork);
    }
    const filter = url.searchParams.get("filter") ?? "";
    if (filter.includes("cites:")) {
      return json({
        results: [
          {
            id: "https://openalex.org/W300",
            display_name: "Citing Work",
            publication_year: 2023,
            doi: "https://doi.org/10.1000/citing-oa",
          },
        ],
      });
    }
    if (filter.includes("openalex:")) return json(referencedWorks(filter));
    if (filter.includes("authorships.author.id")) {
      return json({
        results: [
          {
            id: "https://openalex.org/W777",
            display_name: "Compiler Notes",
            publication_year: 1952,
          },
        ],
      });
    }
    const search = url.searchParams.get("search") ?? "";
    if (search.includes("split")) {
      return json({
        results: [
          {
            id: "https://openalex.org/W222",
            display_name: "Same Title",
            publication_year: 2020,
            doi: "https://doi.org/10.1000/beta",
            open_access: { is_oa: false },
          },
        ],
      });
    }
    return json({ results: [openAlexWork] });
  }

  if (host === "www.ebi.ac.uk") {
    if (path.endsWith("/fullTextXML")) {
      return xml("<article><body><p>Hello world</p></body></article>");
    }
    if (path.endsWith("/citations")) {
      return json({
        citationList: {
          citation: [
            {
              title: "Citing Paper",
              doi: "10.1000/citing",
              pubYear: 2023,
              authorString: "A Person",
            },
          ],
        },
      });
    }
    if (path.endsWith("/references")) {
      return json({
        referenceList: {
          reference: [
            {
              title: "Europe Cited Work",
              doi: "10.1000/cited",
              pubYear: 2017,
              authorString: "B Person",
            },
          ],
        },
      });
    }
    const query = url.searchParams.get("query") ?? "";
    if (query.includes("PMCID:PMC101")) {
      return json(europeRecord("PMC101", "cc by", "Y", "Open Licensed Article"));
    }
    if (query.includes("PMCID:PMC102")) {
      return json(europeRecord("PMC102", "all-rights-reserved", "Y", "Closed Licence Article"));
    }
    if (query.includes("PMCID:PMC103")) {
      return json(europeRecord("PMC103", "cc by", "N", "Not Open Article"));
    }
    if (query.includes("PMCID:PMC999")) {
      return json(europeRecord("PMC999", "cc-by", "Y", "PMC Record"));
    }
    if (query.includes("latte")) {
      return json({
        resultList: {
          result: [
            {
              id: "555",
              pmid: "555",
              title: "Cafe Latte, Models",
              authorString: "Grace Hopper",
              pubYear: 2021,
              isOpenAccess: "N",
              abstractText: "A title variant.",
            },
          ],
        },
      });
    }
    return json({
      resultList: {
        result: {
          id: "42",
          doi: "10.2000/europe",
          pmid: "42",
          title: "Europe PMC Attention Note",
          authorString: "Grace Hopper",
          pubYear: "2019",
          journalInfo: { journal: { title: "Euro Journal" } },
          abstractText: "A European abstract.",
          isOpenAccess: "Y",
          license: "cc-by",
          citedByCount: 3,
          extra: "ignored",
        },
      },
    });
  }

  if (host === "eutils.ncbi.nlm.nih.gov") {
    if (path.includes("esearch")) return json({ esearchresult: { idlist: ["12345"] } });
    return xml(PUBMED_XML);
  }

  if (host === "doaj.org") {
    if (raw.includes("latte")) {
      return json({
        results: [
          {
            id: "doajcafe01",
            bibjson: {
              title: "Café Latte Models",
              year: 2021,
              author: [{ name: "Grace Hopper", orcid: "0000-0001-5109-3700" }],
              link: [{ type: "fulltext", url: "https://doaj.example/latte" }],
              license: [{ url: "https://creativecommons.org/licenses/by/4.0" }],
              abstract: "Steam and pressure.",
              journal: { title: "Coffee Journal" },
            },
          },
        ],
      });
    }
    return json({
      results: [
        {
          id: "doajattn01",
          bibjson: {
            title: "DOAJ Attention Note",
            year: 2022,
            author: [{ name: "Grace Hopper", orcid: "0000-0001-5109-3700" }],
            identifier: [{ type: "doi", id: "10.3000/DOAJ" }],
            link: [{ type: "fulltext", url: "https://doaj.example/attention" }],
            license: [{ url: "https://creativecommons.org/licenses/by/4.0" }],
            abstract: "Indexed in DOAJ.",
            journal: { title: "Open Journal" },
            unexpected: true,
          },
        },
      ],
    });
  }

  if (host === "api.unpaywall.org") {
    if (raw.includes("10.9000/missing")) return text("missing", 404);
    if (raw.includes("10.5000/empty")) {
      return json({
        doi: "10.5000/empty",
        is_oa: false,
        best_oa_location: null,
        oa_locations: [],
      });
    }
    return json({
      doi: "10.1000/transformer",
      is_oa: true,
      best_oa_location: {
        url: "https://oa.example/landing",
        url_for_pdf: "https://oa.example/paper.pdf",
        license: "cc-by",
        version: "publishedVersion",
        host_type: "repository",
      },
      oa_locations: [
        {
          url: "https://oa.example/landing",
          url_for_pdf: "https://oa.example/paper.pdf",
          license: "cc-by",
          version: "publishedVersion",
          host_type: "repository",
        },
      ],
      ignored: true,
    });
  }

  return text("unexpected host", 500);
}
