import type { Config } from "./config.js";
import type { UpstreamId } from "./paper.js";
import type { WaitingScheduler } from "./schedule.js";
import type { Upstream } from "./upstream.js";

export interface SourceContext {
  config: Config;
  upstream: Upstream;
  schedulers: Record<UpstreamId, WaitingScheduler>;
}

export interface SearchRequest {
  query: string;
  limit: number;
  yearFrom?: number;
  yearTo?: number;
  openAccessOnly: boolean;
  arxivCategory?: string;
}

export const FULL_TEXT_CAP = 80_000;
