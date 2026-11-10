import { describe, expect, it } from 'vitest';
import { RateLimiter } from '../src/lib/rate-limit.ts';

const at = (iso: string): Date => new Date(iso);

describe('RateLimiter', () => {
  it('allows `max` hits per window and refuses the next one', () => {
    const limiter = new RateLimiter(60);
    const now = at('2026-11-10T08:00:10Z');
    expect(limiter.hit('ip:1', 3, now)).toEqual({ allowed: true, retryAfterSec: 0 });
    expect(limiter.hit('ip:1', 3, now).allowed).toBe(true);
    expect(limiter.hit('ip:1', 3, now).allowed).toBe(true);
    expect(limiter.hit('ip:1', 3, now)).toEqual({ allowed: false, retryAfterSec: 50 });
  });

  it('counts buckets separately', () => {
    const limiter = new RateLimiter(60);
    const now = at('2026-11-10T08:00:00Z');
    expect(limiter.hit('ip:1', 1, now).allowed).toBe(true);
    expect(limiter.hit('ip:1', 1, now).allowed).toBe(false);
    expect(limiter.hit('ip:2', 1, now).allowed).toBe(true);
    expect(limiter.hit('key:abc', 1, now).allowed).toBe(true);
  });

  it('starts fresh when the next window begins', () => {
    const limiter = new RateLimiter(60);
    expect(limiter.hit('ip:1', 1, at('2026-11-10T08:00:59Z')).allowed).toBe(true);
    expect(limiter.hit('ip:1', 1, at('2026-11-10T08:00:59Z'))).toEqual({ allowed: false, retryAfterSec: 1 });
    expect(limiter.hit('ip:1', 1, at('2026-11-10T08:01:00Z')).allowed).toBe(true);
  });

  it('forgets the buckets of finished windows', () => {
    const limiter = new RateLimiter(60);
    for (let i = 0; i < 500; i++) limiter.hit(`ip:${i}`, 5, at('2026-11-10T08:00:00Z'));
    expect(limiter.size).toBe(500);
    limiter.hit('ip:new', 5, at('2026-11-10T08:05:00Z'));
    expect(limiter.size).toBe(1);
  });

  it('keeps its memory bounded inside one window', () => {
    const limiter = new RateLimiter(60, 1000);
    const now = at('2026-11-10T08:00:00Z');
    for (let i = 0; i < 20_000; i++) limiter.hit(`ip:${i}`, 5, now);
    expect(limiter.size).toBeLessThanOrEqual(1000);
    // A bucket that is still present keeps counting.
    expect(limiter.hit('ip:19999', 2, now).allowed).toBe(true);
    expect(limiter.hit('ip:19999', 2, now).allowed).toBe(false);
  });
});
