import { z } from "zod";
import { brandSecret, type Secret } from "./brand.js";
import { CONNECTOR_NAME, CONNECTOR_VERSION } from "./constants.js";
import { ConnectorError } from "./errors.js";
import { fixedError } from "./zod-messages.js";

const invalid = fixedError("invalid");

const DEFAULT_CONTACT = "contact@example.com";

const EnvSchema = z.object({
  PAPERS_CONTACT_EMAIL: z
    .string({ error: invalid })
    .trim()
    .min(3, { error: invalid })
    .max(120, { error: invalid })
    .optional(),
  OPENALEX_API_KEY: z
    .string({ error: invalid })
    .trim()
    .min(8, { error: invalid })
    .max(512, { error: invalid })
    .optional(),
  NCBI_API_KEY: z
    .string({ error: invalid })
    .trim()
    .min(8, { error: invalid })
    .max(512, { error: invalid })
    .optional(),
  PAPERS_PER_MINUTE: z
    .string({ error: invalid })
    .regex(/^[0-9]+$/, { error: invalid })
    .optional(),
  PAPERS_TIMEOUT_MS: z
    .string({ error: invalid })
    .regex(/^[0-9]+$/, { error: invalid })
    .optional(),
  PAPERS_CACHE_TTL_SEC: z
    .string({ error: invalid })
    .regex(/^[0-9]+$/, { error: invalid })
    .optional(),
  MCP_TRANSPORT: z.enum(["stdio", "http"], { error: invalid }).optional(),
  PORT: z
    .string({ error: invalid })
    .regex(/^[0-9]+$/, { error: invalid })
    .optional(),
});

export interface Config {
  contactEmail: string;
  openAlexApiKey: Secret | undefined;
  ncbiApiKey: Secret | undefined;
  perMinute: number;
  timeoutMs: number;
  cacheTtlSec: number;
  transport: "stdio" | "http";
  port: number;
  userAgent: string;
  contactFromEnv: boolean;
}

function hasControlChar(value: string): boolean {
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

function blank(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function read(env: NodeJS.ProcessEnv, name: string): string | undefined {
  return blank(env[name]);
}

function issueSummary(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path =
        issue.path.length === 0 ? "(root)" : issue.path.map((part) => String(part)).join(".");
      return `${path} (${issue.code})`;
    })
    .join("; ");
}

function boundedInt(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
  field: string,
): number {
  if (raw === undefined) return fallback;
  const parsed = z.number().int().min(min).max(max).safeParse(Number(raw));
  if (!parsed.success) {
    throw new ConnectorError("config", `Invalid environment: ${field} (out_of_range).`);
  }
  return parsed.data;
}

function looksLikeEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

export function loadConfig(env: NodeJS.ProcessEnv, argv: readonly string[]): Config {
  const parsed = EnvSchema.safeParse({
    PAPERS_CONTACT_EMAIL: read(env, "PAPERS_CONTACT_EMAIL"),
    OPENALEX_API_KEY: read(env, "OPENALEX_API_KEY"),
    NCBI_API_KEY: read(env, "NCBI_API_KEY"),
    PAPERS_PER_MINUTE: read(env, "PAPERS_PER_MINUTE"),
    PAPERS_TIMEOUT_MS: read(env, "PAPERS_TIMEOUT_MS"),
    PAPERS_CACHE_TTL_SEC: read(env, "PAPERS_CACHE_TTL_SEC"),
    MCP_TRANSPORT: read(env, "MCP_TRANSPORT"),
    PORT: read(env, "PORT"),
  });
  if (!parsed.success) {
    throw new ConnectorError("config", `Invalid environment: ${issueSummary(parsed.error)}.`);
  }

  const data = parsed.data;
  const contactEmail = data.PAPERS_CONTACT_EMAIL ?? DEFAULT_CONTACT;
  if (hasControlChar(contactEmail) || !looksLikeEmail(contactEmail)) {
    throw new ConnectorError("config", "Invalid environment: PAPERS_CONTACT_EMAIL (invalid).");
  }
  const openAlexApiKey =
    data.OPENALEX_API_KEY === undefined ? undefined : brandSecret(data.OPENALEX_API_KEY);
  const ncbiApiKey = data.NCBI_API_KEY === undefined ? undefined : brandSecret(data.NCBI_API_KEY);
  for (const secret of [openAlexApiKey, ncbiApiKey]) {
    if (secret !== undefined && contactEmail.includes(secret)) {
      throw new ConnectorError(
        "config",
        "Invalid environment: PAPERS_CONTACT_EMAIL (contains_secret).",
      );
    }
  }

  const userAgent = `${CONNECTOR_NAME}/${CONNECTOR_VERSION} (mailto:${contactEmail})`;
  const envTransport = data.MCP_TRANSPORT ?? "stdio";
  return {
    contactEmail,
    openAlexApiKey,
    ncbiApiKey,
    perMinute: boundedInt(data.PAPERS_PER_MINUTE, 60, 1, 10_000, "PAPERS_PER_MINUTE"),
    timeoutMs: boundedInt(data.PAPERS_TIMEOUT_MS, 20_000, 100, 120_000, "PAPERS_TIMEOUT_MS"),
    cacheTtlSec: boundedInt(data.PAPERS_CACHE_TTL_SEC, 60, 0, 86_400, "PAPERS_CACHE_TTL_SEC"),
    transport: argv.includes("--http") ? "http" : envTransport,
    port: boundedInt(data.PORT, 3000, 1, 65_535, "PORT"),
    userAgent,
    contactFromEnv: data.PAPERS_CONTACT_EMAIL !== undefined,
  };
}

export function configSecrets(config: Config): string[] {
  const secrets: string[] = [];
  if (config.openAlexApiKey !== undefined) secrets.push(config.openAlexApiKey);
  if (config.ncbiApiKey !== undefined) secrets.push(config.ncbiApiKey);
  return secrets;
}
