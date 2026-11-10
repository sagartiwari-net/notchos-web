// Fixed-window rate limiter, in memory.
//
// One Node process serves the API (WEB plan decision 2), so the counters live in this
// process. Each bucket (for example "ip:203.0.113.7") may be hit `max` times per window;
// the window is aligned to the clock, so every bucket resets at the same moment.
// Memory is bounded: finished windows are swept, and above `maxBuckets` the oldest
// buckets are dropped (which can only ever let a request through, never block one).

export interface RateLimitDecision {
  allowed: boolean;
  /** Seconds until the current window ends (0 when allowed). */
  retryAfterSec: number;
}

interface Bucket {
  windowStart: number;
  count: number;
}

export class RateLimiter {
  readonly #windowMs: number;
  readonly #maxBuckets: number;
  readonly #buckets = new Map<string, Bucket>();
  #lastSweepWindow = 0;

  constructor(windowSec: number, maxBuckets = 100_000) {
    this.#windowMs = windowSec * 1000;
    this.#maxBuckets = maxBuckets;
  }

  /** Count one hit on `bucket` at time `now` and say whether it is within `max` per window. */
  hit(bucket: string, max: number, now: Date): RateLimitDecision {
    const nowMs = now.getTime();
    const windowStart = Math.floor(nowMs / this.#windowMs) * this.#windowMs;
    this.#sweep(windowStart);

    let entry = this.#buckets.get(bucket);
    if (entry === undefined || entry.windowStart !== windowStart) {
      entry = { windowStart, count: 0 };
      // Re-insert so that Map order stays "oldest window first".
      this.#buckets.delete(bucket);
      this.#buckets.set(bucket, entry);
    }
    entry.count += 1;

    if (entry.count <= max) return { allowed: true, retryAfterSec: 0 };
    return {
      allowed: false,
      retryAfterSec: Math.max(1, Math.ceil((windowStart + this.#windowMs - nowMs) / 1000)),
    };
  }

  get size(): number {
    return this.#buckets.size;
  }

  #sweep(windowStart: number): void {
    if (windowStart !== this.#lastSweepWindow) {
      // A new window began: every bucket of an earlier window is finished.
      this.#lastSweepWindow = windowStart;
      for (const [name, entry] of this.#buckets) {
        if (entry.windowStart !== windowStart) this.#buckets.delete(name);
      }
    }
    if (this.#buckets.size >= this.#maxBuckets) {
      // Too many distinct callers inside one window: drop the oldest tenth.
      let toDrop = Math.ceil(this.#maxBuckets / 10);
      for (const name of this.#buckets.keys()) {
        if (toDrop-- <= 0) break;
        this.#buckets.delete(name);
      }
    }
  }
}
