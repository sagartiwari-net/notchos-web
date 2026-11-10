// Rate limits on activate, refresh, deactivate and trial: per client IP and per license
// key (per device id for the trial). The limits come from the configuration; these tests
// run with 5 requests per IP and 3 per key in a 60-second window.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { toIso } from '../src/lib/time.ts';
import type { Harness } from './helpers/harness.ts';
import { createHarness, deviceId } from './helpers/harness.ts';

let h: Harness;
beforeAll(async () => {
  h = await createHarness({ rateLimit: { windowSec: 60, ipMax: 5, keyMax: 3 } });
});
afterAll(async () => {
  await h.close();
});

/** Each test starts in a fresh window so that earlier tests do not count. */
function nextWindow(): void {
  h.clock.advanceSeconds(60 - (Math.floor(h.clock.now().getTime() / 1000) % 60));
}

let ipCounter = 0;
/** A client address no other test has used. */
function freshIp(): string {
  ipCounter += 1;
  return `203.0.113.${ipCounter}`;
}

describe('limit per IP address', () => {
  it('refuses the request after the limit with 429 rate_limited, Retry-After and server_time', async () => {
    nextWindow();
    h.clock.advanceSeconds(20);
    const ip = freshIp();
    const guess = (n: number) =>
      h.post('/v1/activate', { email: 'buyer@example.com', key: `NOS-AAAAA-AAAAA-AAAAA-AAAA${'BCDEFGH'[n]}`, device_id: deviceId('guesser') }, { ip });

    for (let n = 0; n < 5; n++) expect((await guess(n)).status).toBe(404);

    const blocked = await guess(5);
    expect(blocked.status).toBe(429);
    expect(blocked.body).toEqual({
      error: 'rate_limited',
      message: expect.any(String),
      retry_after: 40,
      server_time: toIso(h.clock.now()),
    });
    expect(blocked.headers['retry-after']).toBe('40');
  });

  it('counts all four POST routes together, and each address on its own', async () => {
    nextWindow();
    const ip = freshIp();
    const license = await h.newLicense();
    const body = { email: 'buyer@example.com', key: license.key, device_id: deviceId('mac-a') };

    expect((await h.post('/v1/activate', body, { ip })).status).toBe(200);
    expect((await h.post('/v1/refresh', body, { ip })).status).toBe(200);
    expect((await h.post('/v1/deactivate', body, { ip })).status).toBe(200);
    expect((await h.post('/v1/trial', { device_id: deviceId('mac-a') }, { ip })).status).toBe(200);
    expect((await h.post('/v1/trial', { device_id: deviceId('mac-b') }, { ip })).status).toBe(200);

    for (const path of ['/v1/activate', '/v1/refresh', '/v1/deactivate', '/v1/trial']) {
      const res = await h.post(path, body, { ip });
      expect(res.status, path).toBe(429);
      expect(res.body.error).toBe('rate_limited');
    }
    // A different address is not affected (use a fresh key so the per-key bucket is empty).
    const other = await h.newLicense();
    expect(
      (
        await h.post(
          '/v1/refresh',
          { email: 'buyer@example.com', key: other.key, device_id: deviceId('mac-a') },
          { ip: freshIp() },
        )
      ).status,
    ).not.toBe(429);
  });

  it('limits before the body is looked at, so junk requests count too', async () => {
    nextWindow();
    const ip = freshIp();
    for (let n = 0; n < 5; n++) expect((await h.post('/v1/activate', { nonsense: true }, { ip })).status).toBe(400);
    expect((await h.post('/v1/activate', { nonsense: true }, { ip })).status).toBe(429);
  });

  it('lets the address in again when the next window starts', async () => {
    nextWindow();
    const ip = freshIp();
    const body = { key: 'NOS-AAAAA-AAAAA-AAAAA-AAAAA', device_id: deviceId('mac-a') };
    for (let n = 0; n < 5; n++) await h.post('/v1/refresh', body, { ip });
    expect((await h.post('/v1/refresh', body, { ip })).status).toBe(429);

    h.clock.advanceSeconds(59);
    expect((await h.post('/v1/refresh', body, { ip })).status).toBe(429);
    h.clock.advanceSeconds(1);
    expect((await h.post('/v1/refresh', body, { ip })).status).toBe(404);
  });

  it('does not limit the health check', async () => {
    nextWindow();
    for (let n = 0; n < 20; n++) expect((await h.get('/v1/health')).status).toBe(200);
  });
});

describe('limit per license key', () => {
  it('refuses a key that is tried too often, whatever address the requests come from', async () => {
    nextWindow();
    const license = await h.newLicense();
    const tryFrom = (n: number) =>
      h.post('/v1/activate', { email: 'buyer@example.com', key: license.key, device_id: deviceId(`mac-${n}`) }, { ip: freshIp() });

    expect((await tryFrom(0)).status).toBe(200);
    expect((await tryFrom(1)).status).toBe(409);
    expect((await tryFrom(2)).status).toBe(409);

    const blocked = await tryFrom(3);
    expect(blocked.status).toBe(429);
    expect(blocked.body).toMatchObject({ error: 'rate_limited', server_time: toIso(h.clock.now()) });
    expect(blocked.headers['retry-after']).toBeDefined();
  });

  it('shares the count between activate, refresh and deactivate, in any spelling of the key', async () => {
    nextWindow();
    const license = await h.newLicense();
    const device_id = deviceId('mac-a');

    expect((await h.post('/v1/activate', { email: 'buyer@example.com', key: license.key, device_id }, { ip: freshIp() })).status).toBe(200);
    expect((await h.post('/v1/refresh', { key: license.key.toLowerCase(), device_id }, { ip: freshIp() })).status).toBe(200);
    expect(
      (await h.post('/v1/deactivate', { key: license.key.replaceAll('-', ' '), device_id }, { ip: freshIp() })).status,
    ).toBe(200);
    expect((await h.post('/v1/activate', { email: 'buyer@example.com', key: license.key, device_id }, { ip: freshIp() })).status).toBe(429);
  });

  it('keeps other keys usable', async () => {
    nextWindow();
    const busy = await h.newLicense();
    const quiet = await h.newLicense();
    for (let n = 0; n < 4; n++) {
      await h.post('/v1/refresh', { key: busy.key, device_id: deviceId('mac-a') }, { ip: freshIp() });
    }
    expect((await h.post('/v1/refresh', { key: busy.key, device_id: deviceId('mac-a') }, { ip: freshIp() })).status).toBe(429);
    expect((await h.post('/v1/activate', { email: 'buyer@example.com', key: quiet.key, device_id: deviceId('mac-a') }, { ip: freshIp() })).status).toBe(200);
  });
});

describe('limit per device on /v1/trial', () => {
  it('refuses a device id that asks too often', async () => {
    nextWindow();
    const device_id = deviceId('trial-hammer');
    for (let n = 0; n < 3; n++) {
      expect((await h.post('/v1/trial', { device_id }, { ip: freshIp() })).status).toBe(200);
    }
    const blocked = await h.post('/v1/trial', { device_id }, { ip: freshIp() });
    expect(blocked.status).toBe(429);
    expect(blocked.body).toMatchObject({ error: 'rate_limited', server_time: toIso(h.clock.now()) });

    expect((await h.post('/v1/trial', { device_id: deviceId('trial-other') }, { ip: freshIp() })).status).toBe(200);
  });
});
