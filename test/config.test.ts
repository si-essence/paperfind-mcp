import { describe, expect, it } from "vitest";
import { CONNECTOR_NAME, CONNECTOR_VERSION } from "../src/constants.js";
import { loadConfig } from "../src/config.js";
import { ConnectorError } from "../src/errors.js";

const KEY = "abcd1234secret";

function messageOf(error: unknown): string {
  expect(error).toBeInstanceOf(ConnectorError);
  if (!(error instanceof ConnectorError)) throw error;
  return error.message;
}

function catchError(fn: () => unknown): unknown {
  try {
    fn();
    return undefined;
  } catch (error) {
    return error;
  }
}

describe("loadConfig", () => {
  it("applies defaults", () => {
    const config = loadConfig({}, []);
    expect(config.openAlexApiKey).toBeUndefined();
    expect(config.ncbiApiKey).toBeUndefined();
    expect(config.contactEmail).toBe("contact@example.com");
    expect(config.contactFromEnv).toBe(false);
    expect(config.perMinute).toBe(60);
    expect(config.timeoutMs).toBe(20_000);
    expect(config.cacheTtlSec).toBe(60);
    expect(config.transport).toBe("stdio");
    expect(config.port).toBe(3000);
    expect(config.userAgent).toBe(
      `${CONNECTOR_NAME}/${CONNECTOR_VERSION} (mailto:contact@example.com)`,
    );
  });

  it("lets --http override the transport", () => {
    expect(loadConfig({ MCP_TRANSPORT: "stdio" }, ["node", "app", "--http"]).transport).toBe(
      "http",
    );
    expect(loadConfig({ MCP_TRANSPORT: "http" }, []).transport).toBe("http");
  });

  it("reports invalid fields without the rejected value or the api key", () => {
    const message = messageOf(
      catchError(() =>
        loadConfig({ OPENALEX_API_KEY: KEY, PORT: "nope", MCP_TRANSPORT: "sse" }, []),
      ),
    );
    expect(message).toContain("PORT");
    expect(message).toContain("MCP_TRANSPORT");
    expect(message).not.toContain(KEY);
    expect(message).not.toContain("nope");
    expect(message).not.toContain("sse");
  });

  it("rejects a short api key without echoing it", () => {
    const message = messageOf(catchError(() => loadConfig({ NCBI_API_KEY: "short" }, [])));
    expect(message).toContain("NCBI_API_KEY");
    expect(message).not.toContain("short");
  });

  it("rejects a contact email that contains a secret", () => {
    const message = messageOf(
      catchError(() =>
        loadConfig(
          { OPENALEX_API_KEY: KEY, PAPERS_CONTACT_EMAIL: `user+${KEY}@example.com` },
          [],
        ),
      ),
    );
    expect(message).toContain("contains_secret");
    expect(message).not.toContain(KEY);
  });

  it("rejects an email that is not an email, without echoing it", () => {
    const message = messageOf(
      catchError(() => loadConfig({ PAPERS_CONTACT_EMAIL: "not-an-email" }, [])),
    );
    expect(message).toContain("PAPERS_CONTACT_EMAIL");
    expect(message).not.toContain("not-an-email");
  });
});
