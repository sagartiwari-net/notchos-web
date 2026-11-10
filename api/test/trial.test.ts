// POST /v1/trial: LICENSE plan test row 13 on the server side (one trial per device, the
// same dates on a repeat call), plus what happens after the trial has ended.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays, addSeconds, toIso } from '../src/lib/time.ts';
import type { Harness } from './helpers/harness.ts';
import { createHarness, deviceId } from './helpers/harness.ts';

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h.close();
});

interface TrialRow {
  device_id: string;
  started_at: Date;
  expires_at: Date;
  app_version: string | null;
  ip: string | null;
}

async function trialRows(device: string): Promise<TrialRow[]> {
  return h.sql.query<TrialRow[]>(
    'SELECT device_id, started_at, expires_at, app_version, ip FROM trials WHERE device_id = ?',
    [device],
  );
}

async function trialEvents(device: string): Promise<{ type: string; detail: string | null; license_id: number | null }[]> {
  return h.sql.query('SELECT type, detail, license_id FROM events WHERE device_id = ? ORDER BY id', [device]);
}

describe('starting a trial', () => {
  it('stores the device and returns a 7-day token bound to it, without key or email', async () => {
    const device = deviceId('trial-first');
    const start = h.clock.now();
    const end = addDays(start, 7);

    const res = await h.post('/v1/trial', { device_id: device, app_version: '1.0.0' }, { ip: '203.0.113.9' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      token: expect.any(String),
      plan: 'trial',
      started_at: toIso(start),
      expires_at: toIso(end),
      refresh_by: toIso(end),
      server_time: toIso(start),
    });
    expect(h.payloadOf(res.body.token)).toEqual({
      kid: h.ctx.signer.kid,
      license_id: null,
      device_id: device,
      plan: 'trial',
      issued_at: toIso(start),
      expires_at: toIso(end),
      refresh_by: toIso(end),
    });
    expect(await trialRows(device)).toEqual([
      { device_id: device, started_at: start, expires_at: end, app_version: '1.0.0', ip: '203.0.113.9' },
    ]);
    expect(await trialEvents(device)).toEqual([{ type: 'trial', detail: 'started', license_id: null }]);
  });

  it('uses the trial_days setting for new trials only', async () => {
    const early = deviceId('trial-days-early');
    await h.post('/v1/trial', { device_id: early });

    await h.sql.query("UPDATE settings SET value = '14' WHERE name = 'trial_days'");
    try {
      const late = await h.post('/v1/trial', { device_id: deviceId('trial-days-late') });
      expect(late.body.expires_at).toBe(toIso(addDays(h.clock.now(), 14)));

      // A trial that has started keeps the dates it was given.
      const again = await h.post('/v1/trial', { device_id: early });
      expect(again.body.expires_at).toBe(toIso(addDays(h.clock.now(), 7)));
    } finally {
      await h.sql.query("UPDATE settings SET value = '7' WHERE name = 'trial_days'");
    }
  });
});

describe('a second trial on the same Mac (test row 13)', () => {
  it('returns the same start and end date, never a new 7 days', async () => {
    const device = deviceId('trial-repeat');
    const start = h.clock.now();
    const end = addDays(start, 7);
    const first = await h.post('/v1/trial', { device_id: device });

    // Three days later the app is reinstalled / the Keychain was wiped.
    h.clock.advanceDays(3);
    const again = await h.post('/v1/trial', { device_id: device, app_version: '1.0.1' });

    expect(again.status).toBe(200);
    expect(again.body).toEqual({
      token: expect.any(String),
      plan: 'trial',
      started_at: toIso(start),
      expires_at: toIso(end),
      refresh_by: toIso(end),
      server_time: toIso(h.clock.now()),
    });
    expect(again.body.started_at).toBe(first.body.started_at);
    expect(again.body.expires_at).toBe(first.body.expires_at);

    // The new token ends on the original date; only issued_at is the time of this call.
    expect(h.payloadOf(again.body.token)).toEqual({
      ...h.payloadOf(first.body.token),
      issued_at: toIso(h.clock.now()),
    });

    expect(await trialRows(device)).toHaveLength(1);
    expect((await trialRows(device))[0]).toMatchObject({ started_at: start, expires_at: end });
    expect((await trialEvents(device)).map((event) => event.detail)).toEqual([
      'started',
      'same device again, same dates',
    ]);
  });

  it('still answers with a token one second before the end', async () => {
    const device = deviceId('trial-last-second');
    const end = addDays(h.clock.now(), 7);
    await h.post('/v1/trial', { device_id: device });

    h.clock.set(addSeconds(end, -1));
    const res = await h.post('/v1/trial', { device_id: device });
    expect(res.status).toBe(200);
    expect(res.body.expires_at).toBe(toIso(end));
  });

  it('answers trial_used with the original dates and no token once the trial is over', async () => {
    const device = deviceId('trial-over');
    const start = h.clock.now();
    const end = addDays(start, 7);
    await h.post('/v1/trial', { device_id: device });

    for (const later of [end, addDays(end, 30), addDays(end, 400)]) {
      h.clock.set(later);
      const res = await h.post('/v1/trial', { device_id: device });
      expect(res.status).toBe(409);
      expect(res.body).toEqual({
        error: 'trial_used',
        message: expect.any(String),
        started_at: toIso(start),
        expires_at: toIso(end),
        server_time: toIso(later),
      });
      expect(res.body.token).toBeUndefined();
    }
    expect(await trialRows(device)).toHaveLength(1);
    expect((await trialEvents(device)).at(-1)).toEqual({ type: 'deny', detail: 'trial: trial_used', license_id: null });
  });

  it('gives every device its own trial', async () => {
    const one = await h.post('/v1/trial', { device_id: deviceId('trial-one') });
    h.clock.advanceDays(1);
    const two = await h.post('/v1/trial', { device_id: deviceId('trial-two') });
    expect(one.status).toBe(200);
    expect(two.status).toBe(200);
    expect(two.body.started_at).not.toBe(one.body.started_at);
  });

  it('creates one trial when the first calls arrive at the same moment', async () => {
    const device = deviceId('trial-race');
    const results = await Promise.all(Array.from({ length: 10 }, () => h.post('/v1/trial', { device_id: device })));

    expect(results.map((res) => res.status)).toEqual(Array(10).fill(200));
    expect(new Set(results.map((res) => res.body.expires_at)).size).toBe(1);
    expect(await trialRows(device)).toHaveLength(1);
    expect((await trialEvents(device)).filter((event) => event.detail === 'started')).toHaveLength(1);
  });
});

describe('a trial and a license on the same Mac', () => {
  it('are independent: buying and activating a key works during and after the trial', async () => {
    const device = deviceId('trial-then-buy');
    await h.post('/v1/trial', { device_id: device });
    h.clock.advanceDays(8);
    expect((await h.post('/v1/trial', { device_id: device })).body.error).toBe('trial_used');

    const license = await h.newLicense('lifetime');
    const res = await h.post('/v1/activate', { email: 'buyer@example.com', key: license.key, device_id: device });
    expect(res.status).toBe(200);
    expect(h.payloadOf(res.body.token)).toMatchObject({ plan: 'lifetime', license_id: license.id });
  });
});
