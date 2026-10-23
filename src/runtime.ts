import { TtlCache } from "./cache.js";
import { configSecrets, type Config } from "./config.js";
import { createLogger, type Logger } from "./log.js";
import { UPSTREAM_IDS, type UpstreamId } from "./paper.js";
import { policyFor } from "./policies.js";
import { SlidingWindowLimiter } from "./rate-limit.js";
import { WaitingScheduler, type Sleep } from "./schedule.js";
import type { SourceContext } from "./context.js";
import { Upstream } from "./upstream.js";

export interface Runtime {
  config: Config;
  context: SourceContext;
  secrets: readonly string[];
  logger: Logger;
}

export interface RuntimeOverrides {
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: Sleep;
  random?: () => number;
  logger?: Logger;
}

export function createRuntime(config: Config, overrides: RuntimeOverrides = {}): Runtime {
  const now = overrides.now ?? Date.now;
  const sleep = overrides.sleep ?? defaultSleep;
  const secrets = configSecrets(config);
  const logger = overrides.logger ?? createLogger(secrets);
  const upstream = new Upstream({
    fetchImpl: overrides.fetchImpl ?? fetch,
    timeoutMs: config.timeoutMs,
    secrets,
    cache: new TtlCache(now),
    inbound: new SlidingWindowLimiter(config.perMinute, 60_000, now),
    userAgent: config.userAgent,
    logger,
    sleep,
    random: overrides.random ?? Math.random,
  });
  return {
    config,
    context: { config, upstream, schedulers: createSchedulers(config, now, sleep) },
    secrets,
    logger,
  };
}

function createSchedulers(
  config: Config,
  now: () => number,
  sleep: Sleep,
): Record<UpstreamId, WaitingScheduler> {
  const schedulers = {} as Record<UpstreamId, WaitingScheduler>;
  for (const id of UPSTREAM_IDS) {
    const policy = policyFor(config, id);
    schedulers[id] = new WaitingScheduler(policy.minIntervalMs, policy.maxConcurrent, now, sleep);
  }
  return schedulers;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
