import { z } from "zod";
import type { SourceContext } from "../context.js";
import {
  normalizeDoi,
  type Doi,
} from "../paper.js";
import { parseJson, withQuery } from "../values.js";
import { ConnectorError } from "../errors.js";

const locationSchema = z.object({
  url: z.string().nullable().optional(),
  url_for_pdf: z.string().nullable().optional(),
  license: z.string().nullable().optional(),
  version: z.string().nullable().optional(),
  host_type: z.string().nullable().optional(),
});

const recordSchema = z.object({
  doi: z.string().optional(),
  is_oa: z.boolean().optional(),
  best_oa_location: locationSchema.nullable().optional(),
  oa_locations: z.array(locationSchema).optional(),
});

export interface OaLocation {
  url?: string;
  pdfUrl?: string;
  license?: string;
  version?: string;
  hostType?: string;
}

export interface OaReport {
  doi: Doi;
  isOa: boolean;
  best: OaLocation | null;
  locations: OaLocation[];
}

export async function unpaywallByDoi(ctx: SourceContext, doi: Doi): Promise<OaReport> {
  const url = withQuery(`https://api.unpaywall.org/v2/${encodeURIComponent(doi)}`, {
    email: ctx.config.contactEmail,
  });
  const response = await ctx.upstream.getText({
    source: "unpaywall",
    url,
    accept: "application/json",
    scheduler: ctx.schedulers.unpaywall,
    cacheTtlSec: ctx.config.cacheTtlSec,
  });
  return reportFromPayload(doi, parseJson(response.text, "unpaywall"));
}

export function reportFromPayload(doi: Doi, payload: unknown): OaReport {
  const parsed = recordSchema.safeParse(payload);
  if (!parsed.success) {
    throw new ConnectorError("upstream_unavailable", "unpaywall response did not match the expected shape.");
  }
  const locations = (parsed.data.oa_locations ?? []).map(locationFrom).filter((item) => item !== null);
  const best = parsed.data.best_oa_location == null ? null : locationFrom(parsed.data.best_oa_location);
  return {
    doi: normalizeDoi(parsed.data.doi) ?? doi,
    isOa: parsed.data.is_oa === true,
    best,
    locations,
  };
}

function locationFrom(value: z.infer<typeof locationSchema>): OaLocation | null {
  const location: OaLocation = {};
  if (typeof value.url === "string" && value.url.length > 0) location.url = value.url;
  if (typeof value.url_for_pdf === "string" && value.url_for_pdf.length > 0) location.pdfUrl = value.url_for_pdf;
  if (typeof value.license === "string" && value.license.length > 0) location.license = value.license;
  if (typeof value.version === "string" && value.version.length > 0) location.version = value.version;
  if (typeof value.host_type === "string" && value.host_type.length > 0) location.hostType = value.host_type;
  if (location.url === undefined && location.pdfUrl === undefined) return null;
  return location;
}

export function locationRecord(location: OaLocation): Record<string, unknown> {
  return {
    ...(location.url === undefined ? {} : { url: location.url }),
    ...(location.pdfUrl === undefined ? {} : { pdfUrl: location.pdfUrl }),
    ...(location.license === undefined ? {} : { license: location.license }),
    ...(location.version === undefined ? {} : { version: location.version }),
    ...(location.hostType === undefined ? {} : { hostType: location.hostType }),
  };
}
