// Logs never contain a key, a token or a secret. The whole flow runs with logging at
// trace level into a buffer, and the buffer is searched for everything that must not be
// in it.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Harness } from './helpers/harness.ts';
import { createHarness, deviceId } from './helpers/harness.ts';

const lines: string[] = [];
let h: Harness;

beforeAll(async () => {
  h = await createHarness({ logStream: { write: (line) => void lines.push(line) }, logLevel: 'trace' });
});
afterAll(async () => {
  await h.close();
});

describe('application log', () => {
  it('records requests and outcomes, but no key, token or secret', async () => {
    const license = await h.newLicense('lifetime');
    const expiring = await h.newLicense('monthly', { days: 1 });
    const A = deviceId('mac-a');
    const B = deviceId('mac-b');
    const tokens: string[] = [];
    const keep = (res: { body: { token?: string } }) => {
      if (typeof res.body.token === 'string') tokens.push(res.body.token);
    };

    keep(await h.post('/v1/activate', { email: 'buyer@example.com', key: license.key, device_id: A, device_name: 'Mac A', app_version: '1.0' }));
    keep(await h.post('/v1/activate', { email: 'buyer@example.com', key: license.key.toLowerCase(), device_id: B }));
    keep(await h.post('/v1/activate', { email: 'buyer@example.com', key: license.key, device_id: B, transfer: true }));
    keep(await h.post('/v1/refresh', { key: license.key, device_id: B }));
    keep(await h.post('/v1/refresh', { key: license.key, device_id: A }));
    keep(await h.post('/v1/deactivate', { key: license.key, device_id: B }));
    keep(await h.post('/v1/trial', { device_id: A }));
    keep(await h.post('/v1/activate', { email: 'buyer@example.com', key: expiring.key, device_id: A }));
    h.clock.advanceDays(2);
    keep(await h.post('/v1/refresh', { key: expiring.key, device_id: A }));

    // Requests that go wrong in every way the server knows.
    await h.post('/v1/activate', { email: 'buyer@example.com', key: license.key, device_id: 'bad id' });
    await h.post(`/v1/activate?key=${license.key}`, { key: license.key });
    await h.app.inject({
      method: 'POST',
      url: '/v1/activate',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${license.key}` },
      payload: `{"key":"${license.key}","device_id":`,
    });
    await h.app.inject({
      method: 'POST',
      url: '/v1/activate',
      headers: { 'content-type': 'text/plain' },
      payload: license.key,
    });
    await h.get(`/nothing/${'x'.repeat(10)}?token=${tokens[0]}`);

    // A database failure with a key in the request.
    await h.ctx.db.end();
    const failed = await h.post('/v1/activate', { email: 'buyer@example.com', key: license.key, device_id: A });
    expect(failed.status).toBe(500);

    const log = lines.join('');
    expect(tokens.length).toBeGreaterThanOrEqual(5);

    // The log is not empty: requests, outcomes and the failure are there.
    expect(log).toContain('"msg":"incoming request"');
    expect(log).toContain('"path":"/v1/activate"');
    expect(log).toContain('"outcome":"activated"');
    expect(log).toContain('"outcome":"transferred"');
    expect(log).toContain('"outcome":"already_active"');
    expect(log).toContain('"outcome":"seat_moved"');
    expect(log).toContain('"outcome":"expired"');
    expect(log).toContain('"outcome":"bad_request"');
    expect(log).toContain('"msg":"request failed"');
    expect(log).toContain(`"license_id":${license.id}`);

    // Keys, in any spelling.
    for (const key of [license.key, expiring.key]) {
      expect(log).not.toContain(key);
      expect(log).not.toContain(key.toLowerCase());
      expect(log).not.toContain(key.replaceAll('-', ''));
      expect(log).not.toContain(key.slice(4, 15));
    }
    // Tokens: whole, payload part and signature part.
    for (const token of tokens) {
      const [payloadPart, signaturePart] = token.split('.') as [string, string];
      expect(log).not.toContain(token);
      expect(log).not.toContain(payloadPart);
      expect(log).not.toContain(signaturePart);
    }
    // Secrets.
    expect(log).not.toContain(h.config.db.password);
    expect(log).not.toContain(h.settings.admin.password);
    expect(log).not.toContain(h.config.keyEncSecret.toString('base64'));
    expect(log).not.toContain(h.config.keyEncSecret.toString('hex'));
    // No query strings, headers or bodies.
    expect(log).not.toContain('?key=');
    expect(log).not.toContain('?token=');
    expect(log).not.toContain('authorization');
    expect(log).not.toContain('Bearer');
  });

  it('replaces sensitive fields if a later change ever logs them', () => {
    const before = lines.length;
    h.app.log.info(
      { key: 'NOS-LEAKY-LEAKY-LEAKY-LEAKY', token: 'tok.en', body: { key: 'x' }, config: { password: 'pw-leak' } },
      'careless log call',
    );
    const written = lines.slice(before).join('');
    expect(written).toContain('careless log call');
    expect(written).toContain('[redacted]');
    for (const leaked of ['NOS-LEAKY', 'tok.en', 'pw-leak']) expect(written).not.toContain(leaked);
  });
});
