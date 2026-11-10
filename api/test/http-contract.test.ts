// The HTTP surface as a whole: server_time in every answer, request validation, body and
// content-type limits, response headers, the client address, and what happens when the
// database is down.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { API_ERRORS } from '../src/http/respond.ts';
import { toIso } from '../src/lib/time.ts';
import type { ApiResponse, Harness } from './helpers/harness.ts';
import { createHarness, deviceId } from './helpers/harness.ts';

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h.close();
});

const WIRE_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const A = deviceId('mac-a');
const B = deviceId('mac-b');

function raw(method: string, url: string, payload?: string, headers: Record<string, string> = {}) {
  return h.app.inject({ method: method as 'GET', url, payload, headers });
}

describe('server_time', () => {
  it('is in every answer: successes, refusals, bad requests, unknown routes', async () => {
    const lifetime = await h.newLicense('lifetime');
    const monthly = await h.newLicense('monthly', { days: 1 });
    const revoked = await h.newLicense('lifetime');
    await h.sql.query("UPDATE licenses SET status = 'revoked' WHERE id = ?", [revoked.id]);

    const answers: Array<[string, ApiResponse | { status: number; body: unknown }]> = [];
    const add = async (label: string, pending: Promise<ApiResponse>) => answers.push([label, await pending]);

    await add('health', h.get('/v1/health'));
    await add('activate ok', h.post('/v1/activate', { email: 'buyer@example.com', key: lifetime.key, device_id: A }));
    await add('already_active', h.post('/v1/activate', { email: 'buyer@example.com', key: lifetime.key, device_id: B }));
    await add('transfer ok', h.post('/v1/activate', { email: 'buyer@example.com', key: lifetime.key, device_id: B, transfer: true }));
    await add('refresh ok', h.post('/v1/refresh', { key: lifetime.key, device_id: B }));
    await add('seat_moved', h.post('/v1/refresh', { key: lifetime.key, device_id: A }));
    await add('deactivate ok', h.post('/v1/deactivate', { key: lifetime.key, device_id: B }));
    await add('revoked', h.post('/v1/activate', { email: 'buyer@example.com', key: revoked.key, device_id: A }));
    await add('invalid_key', h.post('/v1/activate', { email: 'buyer@example.com', key: 'nope', device_id: A }));
    await add('trial ok', h.post('/v1/trial', { device_id: A }));
    await add('bad_request', h.post('/v1/activate', { email: 'buyer@example.com', device_id: A }));
    await add('not_found', h.get('/v1/nothing-here'));
    await add('not_found outside /v1', h.get('/'));

    h.clock.advanceDays(8);
    await add('expired', h.post('/v1/activate', { email: 'buyer@example.com', key: monthly.key, device_id: A }));
    await add('trial_used', h.post('/v1/trial', { device_id: A }));

    for (const text of ['{"key": ', '']) {
      const res = await raw('POST', '/v1/activate', text, { 'content-type': 'application/json' });
      answers.push([`malformed json ${JSON.stringify(text)}`, { status: res.statusCode, body: res.json() }]);
    }

    const seen = new Set<string>();
    for (const [label, answer] of answers) {
      const body = answer.body as Record<string, unknown>;
      expect(body.server_time, label).toMatch(WIRE_DATE);
      seen.add(answer.status === 200 ? 'ok' : String(body.error));
    }
    // The sweep really covered each kind of answer.
    expect([...seen].sort()).toEqual(
      ['already_active', 'bad_request', 'expired', 'invalid_key', 'not_found', 'ok', 'revoked', 'seat_moved', 'trial_used'].sort(),
    );
  });

  it('is the server clock at the moment of the answer', async () => {
    h.clock.set(new Date('2027-03-01T12:34:56.789Z'));
    expect((await h.get('/v1/health')).body).toEqual({ status: 'ok', server_time: '2027-03-01T12:34:56Z' });
  });

  it('uses the same encoding as every other date: UTC, whole seconds, trailing Z', async () => {
    const license = await h.newLicense('monthly', { days: 30 });
    const res = await h.post('/v1/activate', { email: 'buyer@example.com', key: license.key, device_id: A });
    const payload = h.payloadOf(res.body.token);
    for (const value of [res.body.server_time, res.body.expires_at, res.body.refresh_by, payload.issued_at, payload.expires_at, payload.refresh_by]) {
      expect(value).toMatch(WIRE_DATE);
    }
    const refused = await h.post('/v1/activate', { email: 'buyer@example.com', key: license.key, device_id: B });
    expect(refused.body.activated_at).toMatch(WIRE_DATE);
  });
});

describe('request validation', () => {
  const key = 'NOS-AAAAA-AAAAA-AAAAA-AAAAA';

  it('answers 400 bad_request for a body that does not match the schema', async () => {
    const cases: Array<[string, string, unknown]> = [
      ['no key', '/v1/activate', { device_id: A }],
      ['no device_id', '/v1/activate', { key }],
      ['key is a number', '/v1/activate', { key: 12345, device_id: A }],
      ['key is null', '/v1/activate', { key: null, device_id: A }],
      ['device_id too short', '/v1/activate', { key, device_id: 'short' }],
      ['device_id too long', '/v1/activate', { key, device_id: 'a'.repeat(129) }],
      ['device_id with other characters', '/v1/activate', { key, device_id: `${'a'.repeat(20)}'; --` }],
      ['device_id is an object', '/v1/activate', { key, device_id: { $ne: '' } }],
      ['transfer is a string', '/v1/activate', { key, device_id: A, transfer: 'true' }],
      ['transfer is a number', '/v1/activate', { key, device_id: A, transfer: 1 }],
      ['device_name is too long', '/v1/activate', { key, device_id: A, device_name: 'x'.repeat(256) }],
      ['device_name is a number', '/v1/activate', { key, device_id: A, device_name: 5 }],
      ['app_version is too long', '/v1/activate', { key, device_id: A, app_version: 'x'.repeat(65) }],
      ['body is an array', '/v1/activate', [key, A]],
      ['body is a string', '/v1/activate', 'hello'],
      ['refresh without key', '/v1/refresh', { device_id: A }],
      ['refresh without device_id', '/v1/refresh', { key }],
      ['deactivate without device_id', '/v1/deactivate', { key }],
      ['trial without device_id', '/v1/trial', {}],
      ['trial with a short device_id', '/v1/trial', { device_id: 'abc' }],
    ];
    for (const [label, path, body] of cases) {
      const res = await h.post(path, body);
      expect(res.status, label).toBe(400);
      expect(res.body, label).toEqual({
        error: 'bad_request',
        message: expect.any(String),
        server_time: toIso(h.clock.now()),
      });
    }
  });

  it('describes the rule that failed without repeating what was sent', async () => {
    const secretLooking = 'NOS-ZZZZZ-ZZZZZ-ZZZZZ-ZZZZZ';
    const res = await h.post('/v1/activate', { email: 'buyer@example.com', key: secretLooking, device_id: `bad device id ${secretLooking}` });
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('body/device_id must match pattern "^[A-Za-z0-9_-]+$"');
    expect(JSON.stringify(res.body)).not.toContain(secretLooking);
  });

  it('ignores fields it does not know, so a newer app can send more', async () => {
    const license = await h.newLicense();
    const res = await h.post('/v1/activate', { email: 'buyer@example.com', key: license.key,
      device_id: A,
      os_version: '27.0',
      plan: 'lifetime',
      expires_at: null,
      max_devices: 99,
    });
    expect(res.status).toBe(200);
    const [row] = await h.sql.query<{ max_devices: number }[]>('SELECT max_devices FROM licenses WHERE id = ?', [license.id]);
    expect(row!.max_devices).toBe(1);
  });

  it('accepts JSON only', async () => {
    const body = JSON.stringify({ key, device_id: A });
    const form = await raw('POST', '/v1/activate', `key=${key}&device_id=${A}`, {
      'content-type': 'application/x-www-form-urlencoded',
    });
    expect(form.statusCode).toBe(415);
    expect(form.json()).toMatchObject({ error: 'unsupported_media_type', server_time: toIso(h.clock.now()) });

    const text = await raw('POST', '/v1/activate', body, { 'content-type': 'text/plain' });
    expect([400, 415]).toContain(text.statusCode);
    expect(['bad_request', 'unsupported_media_type']).toContain(text.json().error);

    const none = await raw('POST', '/v1/activate', body, { 'content-type': '' });
    expect([400, 415]).toContain(none.statusCode);
  });

  it('answers 400 for JSON that does not parse, without echoing it', async () => {
    const res = await raw('POST', '/v1/activate', `{"key":"NOS-QQQQQ-QQQQQ-QQQQQ-QQQQQ","device_id":`, {
      'content-type': 'application/json',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      error: 'bad_request',
      message: API_ERRORS.bad_request.message,
      server_time: toIso(h.clock.now()),
    });
    expect(res.body).not.toContain('QQQQQ');
  });

  it('refuses a body above 4 KiB with 413', async () => {
    const big = JSON.stringify({ key, device_id: A, device_name: 'x'.repeat(5000) });
    const res = await raw('POST', '/v1/activate', big, { 'content-type': 'application/json' });
    expect(res.statusCode).toBe(413);
    expect(res.json()).toMatchObject({ error: 'payload_too_large', server_time: toIso(h.clock.now()) });
  });

  it('refuses JSON that tries to reach object prototypes', async () => {
    const res = await raw(
      'POST',
      '/v1/activate',
      `{"key":"${key}","device_id":"${A}","__proto__":{"transfer":true}}`,
      { 'content-type': 'application/json' },
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('bad_request');
  });
});

describe('routes and headers', () => {
  it('answers JSON 404 for unknown paths and for GET on a POST route', async () => {
    for (const [method, url] of [
      ['GET', '/v1/activate'],
      ['GET', '/v1/trial'],
      ['POST', '/v1/health'],
      ['GET', '/v2/health'],
      ['GET', '/admin'],
      ['DELETE', '/v1/activate'],
    ] as const) {
      const res = await raw(method, url);
      expect(res.statusCode, `${method} ${url}`).toBe(404);
      expect(res.json()).toEqual({ error: 'not_found', message: 'No such route.', server_time: toIso(h.clock.now()) });
    }
  });

  it('marks every answer as JSON that must not be cached', async () => {
    const license = await h.newLicense();
    const responses = [
      await h.post('/v1/activate', { email: 'buyer@example.com', key: license.key, device_id: A }),
      await h.post('/v1/activate', { email: 'buyer@example.com', key: 'nope', device_id: A }),
      await h.get('/v1/health'),
      await h.get('/nothing'),
    ];
    for (const res of responses) {
      expect(res.headers['content-type']).toBe('application/json; charset=utf-8');
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
    }
  });
});

describe('client address', () => {
  async function lastIp(harness: Harness): Promise<string | null> {
    const rows = await harness.sql.query<{ ip: string | null }[]>('SELECT ip FROM events ORDER BY id DESC LIMIT 1');
    return rows[0]!.ip;
  }

  it('is the connection address; X-Forwarded-For is ignored without a trusted proxy', async () => {
    await h.post('/v1/trial', { device_id: deviceId('ip-direct') }, {
      ip: '198.51.100.77',
      headers: { 'x-forwarded-for': '10.9.8.7' },
    });
    expect(await lastIp(h)).toBe('198.51.100.77');
  });

  it('comes from X-Forwarded-For only when the proxy on this machine sent the request', async () => {
    const proxied = await createHarness({ trustProxy: true });
    try {
      await proxied.post('/v1/trial', { device_id: deviceId('ip-proxied') }, {
        ip: '127.0.0.1',
        headers: { 'x-forwarded-for': '203.0.113.50' },
      });
      expect(await lastIp(proxied)).toBe('203.0.113.50');

      // Somebody reaching the port directly cannot choose their address.
      await proxied.post('/v1/trial', { device_id: deviceId('ip-spoofed') }, {
        ip: '198.51.100.99',
        headers: { 'x-forwarded-for': '203.0.113.51' },
      });
      expect(await lastIp(proxied)).toBe('198.51.100.99');
    } finally {
      await proxied.close();
    }
  });
});

describe('when the database is down', () => {
  let broken: Harness;
  beforeAll(async () => {
    broken = await createHarness();
    await broken.ctx.db.end();
  });
  afterAll(async () => {
    await broken.close();
  });

  it('answers 503 on the health check', async () => {
    const res = await broken.get('/v1/health');
    expect(res.status).toBe(503);
    expect(res.body).toEqual({
      error: 'unavailable',
      message: expect.any(String),
      server_time: toIso(broken.clock.now()),
    });
  });

  it('answers 500 server_error with server_time and no details', async () => {
    for (const [path, body] of [
      ['/v1/activate', { email: 'buyer@example.com', key: 'NOS-AAAAA-AAAAA-AAAAA-AAAAA', device_id: A }],
      ['/v1/refresh', { key: 'NOS-AAAAA-AAAAA-AAAAA-AAAAA', device_id: A }],
      ['/v1/trial', { device_id: A }],
    ] as const) {
      const res = await broken.post(path, body);
      expect(res.status, path).toBe(500);
      expect(res.body).toEqual({
        error: 'server_error',
        message: API_ERRORS.server_error.message,
        server_time: toIso(broken.clock.now()),
      });
    }
  });
});
