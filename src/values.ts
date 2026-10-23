import { ConnectorError } from "./errors.js";
import type { UpstreamId } from "./paper.js";

export function parseJson(text: string, source: UpstreamId): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ConnectorError("upstream_unavailable", `${source} returned non-JSON.`);
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

export function asArray(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

export function asString(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  return undefined;
}

export function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value.trim())) {
    return Number(value);
  }
  return undefined;
}

export function textContent(value: unknown): string | undefined {
  if (typeof value === "string") return asString(value);
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  const record = asRecord(value);
  if (record === undefined) return undefined;
  return asString(record["#text"]);
}

export function attr(value: unknown, name: string): string | undefined {
  const record = asRecord(value);
  if (record === undefined) return undefined;
  return asString(record[`@_${name}`]);
}

export function field(record: Record<string, unknown> | undefined, key: string): unknown {
  if (record === undefined) return undefined;
  return record[key];
}

export function withQuery(
  base: string,
  query: Readonly<Record<string, string | number | undefined>>,
): string {
  const url = new URL(base);
  for (const key of Object.keys(query).sort()) {
    const value = query[key];
    if (value === undefined) continue;
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}
