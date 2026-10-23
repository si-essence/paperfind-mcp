export type Sleep = (ms: number) => Promise<void>;

export class WaitingScheduler {
  private tail: Promise<void> = Promise.resolve();
  private lastStart = Number.NEGATIVE_INFINITY;
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(
    private minIntervalMs: number,
    private readonly maxConcurrent: number,
    private readonly now: () => number,
    private readonly sleep: Sleep,
  ) {}

  tighten(minIntervalMs: number): void {
    if (minIntervalMs > this.minIntervalMs) this.minIntervalMs = minIntervalMs;
  }

  run<T>(task: () => Promise<T>): Promise<T> {
    const ready = this.acquire();
    this.tail = ready.then(
      () => undefined,
      () => undefined,
    );
    return ready.then(async () => {
      try {
        return await task();
      } finally {
        this.release();
      }
    });
  }

  private acquire(): Promise<void> {
    return this.tail.then(async () => {
      while (this.active >= this.maxConcurrent) {
        await new Promise<void>((resolve) => {
          this.waiters.push(resolve);
        });
      }
      if (this.lastStart !== Number.NEGATIVE_INFINITY) {
        const wait = this.minIntervalMs - (this.now() - this.lastStart);
        if (wait > 0) await this.sleep(wait);
      }
      this.lastStart = this.now();
      this.active += 1;
    });
  }

  private release(): void {
    this.active = Math.max(0, this.active - 1);
    const next = this.waiters.shift();
    if (next !== undefined) next();
  }
}
