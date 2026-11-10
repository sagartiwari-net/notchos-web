// POST /v1/refresh and /v1/deactivate: LICENSE plan test row 10 (refund) on the server
// side, plus seat moves, expiry, renewal and freeing a seat.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays, addSeconds, toIso } from '../src/lib/time.ts';
import { revokeLicense } from '../src/services/licenses.ts';
import type { Harness } from './helpers/harness.ts';
import { createHarness, deviceId } from './helpers/harness.ts';

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h.close();
});

const A = deviceId('mac-a');
const B = deviceId('mac-b');

async function activeDevices(licenseId: number): Promise<string[]> {
  const rows = await h.sql.query<{ device_id: string }[]>(
    'SELECT device_id FROM activations WHERE license_id = ? AND deactivated_at IS NULL ORDER BY id',
    [licenseId],
  );
  return rows.map((row) => row.device_id);
}

async function lastEvent(licenseId: number): Promise<{ type: string; detail: string | null }> {
  const rows = await h.sql.query<{ type: string; detail: string | null }[]>(
    'SELECT type, detail FROM events WHERE license_id = ? ORDER BY id DESC LIMIT 1',
    [licenseId],
  );
  return rows[0]!;
}

describe('POST /v1/refresh', () => {
  it('gives the Mac that holds the seat a fresh token and records that it was seen', async () => {
    const license = await h.newLicense('lifetime');
    const first = await h.post('/v1/activate', { email: 'buyer@example.com', key: license.key, device_id: A, app_version: '1.0.0' });

    h.clock.advanceDays(5);
    const now = h.clock.now();
    const res = await h.post('/v1/refresh', { key: license.key, device_id: A, app_version: '1.0.1' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      token: expect.any(String),
      plan: 'lifetime',
      expires_at: null,
      refresh_by: toIso(addDays(now, 30)),
      server_time: toIso(now),
    });
    // The 30 days roll forward with every refresh.
    expect(h.payloadOf(res.body.token)).toMatchObject({
      license_id: license.id,
      device_id: A,
      issued_at: toIso(now),
      refresh_by: toIso(addDays(now, 30)),
    });
    expect(h.payloadOf(res.body.token).refresh_by).not.toBe(h.payloadOf(first.body.token).refresh_by);

    const [seat] = await h.sql.query<{ last_seen_at: Date; app_version: string }[]>(
      'SELECT last_seen_at, app_version FROM activations WHERE license_id = ?',
      [license.id],
    );
    expect(seat).toEqual({ last_seen_at: now, app_version: '1.0.1' });
    expect(await lastEvent(license.id)).toEqual({ type: 'refresh', detail: null });
  });

  it('fails with revoked after a refund, and never hands out a token again (test row 10)', async () => {
    const license = await h.newLicense('lifetime');
    await h.post('/v1/activate', { email: 'buyer@example.com', key: license.key, device_id: A });
    expect((await h.post('/v1/refresh', { key: license.key, device_id: A })).status).toBe(200);

    // What the refund webhook and the admin's "revoke" do.
    const revoked = await revokeLicense(h.ctx.db, license.id, 'test', h.clock.now());
    expect(revoked?.changed).toBe(true);

    const res = await h.post('/v1/refresh', { key: license.key, device_id: A });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'revoked', message: expect.any(String), server_time: toIso(h.clock.now()) });
    expect(res.body.token).toBeUndefined();
    expect(await lastEvent(license.id)).toEqual({ type: 'deny', detail: 'refresh: revoked' });

    // Activating again does not help either.
    expect((await h.post('/v1/activate', { email: 'buyer@example.com', key: license.key, device_id: A })).body.error).toBe('revoked');
    // Revoking twice changes nothing.
    expect((await revokeLicense(h.ctx.db, license.id, 'test', h.clock.now()))?.changed).toBe(false);
  });

  it('fails with seat_moved for the old Mac after a transfer', async () => {
    const license = await h.newLicense('lifetime');
    await h.post('/v1/activate', { email: 'buyer@example.com', key: license.key, device_id: A });
    await h.post('/v1/activate', { email: 'buyer@example.com', key: license.key, device_id: B, transfer: true });

    const old = await h.post('/v1/refresh', { key: license.key, device_id: A });
    expect(old.status).toBe(409);
    expect(old.body).toEqual({ error: 'seat_moved', message: expect.any(String), server_time: toIso(h.clock.now()) });

    expect((await h.post('/v1/refresh', { key: license.key, device_id: B })).status).toBe(200);
  });

  it('fails with seat_moved for a Mac that never activated', async () => {
    const license = await h.newLicense('lifetime');
    const res = await h.post('/v1/refresh', { key: license.key, device_id: A });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('seat_moved');
  });

  it('fails with expired once a monthly license has run out', async () => {
    const license = await h.newLicense('monthly', { days: 30 });
    const expiry = addDays(h.clock.now(), 30);
    await h.post('/v1/activate', { email: 'buyer@example.com', key: license.key, device_id: A });

    h.clock.set(addSeconds(expiry, -1));
    const lastGood = await h.post('/v1/refresh', { key: license.key, device_id: A });
    expect(lastGood.status).toBe(200);
    expect(lastGood.body).toMatchObject({ expires_at: toIso(expiry), refresh_by: toIso(expiry) });

    h.clock.set(expiry);
    const res = await h.post('/v1/refresh', { key: license.key, device_id: A });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({
      error: 'expired',
      message: expect.any(String),
      expires_at: toIso(expiry),
      server_time: toIso(expiry),
    });
  });

  it('returns the new expiry after a renewal, with the same key', async () => {
    const license = await h.newLicense('monthly', { days: 30 });
    const firstExpiry = addDays(h.clock.now(), 30);
    await h.post('/v1/activate', { email: 'buyer@example.com', key: license.key, device_id: A });

    // A renewal (phase W3) extends the same license row.
    const renewedExpiry = addDays(firstExpiry, 30);
    await h.sql.query('UPDATE licenses SET period_end = ?, expires_at = ? WHERE id = ?', [
      renewedExpiry,
      renewedExpiry,
      license.id,
    ]);

    // Even a Mac that was offline past the old date gets Pro back on its next refresh.
    h.clock.set(addDays(firstExpiry, 2));
    const res = await h.post('/v1/refresh', { key: license.key, device_id: A });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ expires_at: toIso(renewedExpiry), refresh_by: toIso(renewedExpiry) });
    expect(h.payloadOf(res.body.token).expires_at).toBe(toIso(renewedExpiry));
  });

  it('tells a Mac without a seat that the seat moved, even when the license has also expired', async () => {
    const license = await h.newLicense('monthly', { days: 1 });
    await h.post('/v1/activate', { email: 'buyer@example.com', key: license.key, device_id: A });
    await h.post('/v1/activate', { email: 'buyer@example.com', key: license.key, device_id: B, transfer: true });
    h.clock.advanceDays(2);

    expect((await h.post('/v1/refresh', { key: license.key, device_id: A })).body.error).toBe('seat_moved');
    expect((await h.post('/v1/refresh', { key: license.key, device_id: B })).body.error).toBe('expired');
  });

  it('answers invalid_key for a wrong or unknown key', async () => {
    for (const key of ['nonsense', 'NOS-AAAAA-AAAAA-AAAAA-AAAAA']) {
      const res = await h.post('/v1/refresh', { key, device_id: A });
      expect(res.status).toBe(404);
      expect(res.body).toEqual({
        error: 'invalid_key',
        message: 'This license key is not valid.',
        server_time: toIso(h.clock.now()),
      });
    }
  });
});

describe('POST /v1/deactivate', () => {
  it('frees the seat, so another Mac can activate without a transfer', async () => {
    const license = await h.newLicense('lifetime');
    await h.post('/v1/activate', { email: 'buyer@example.com', key: license.key, device_id: A });

    const res = await h.post('/v1/deactivate', { key: license.key, device_id: A });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ deactivated: true, server_time: toIso(h.clock.now()) });
    expect(await activeDevices(license.id)).toEqual([]);
    expect(await lastEvent(license.id)).toEqual({ type: 'deactivate', detail: 'by this Mac' });

    // The Mac that let go is told so on refresh.
    expect((await h.post('/v1/refresh', { key: license.key, device_id: A })).body.error).toBe('seat_moved');

    const other = await h.post('/v1/activate', { email: 'buyer@example.com', key: license.key, device_id: B });
    expect(other.status).toBe(200);
    expect(other.body).toMatchObject({ transferred: false, transfers_left: 2 });
    expect(await activeDevices(license.id)).toEqual([B]);
  });

  it('is harmless to repeat, and only touches the calling Mac', async () => {
    const license = await h.newLicense('lifetime');
    await h.post('/v1/activate', { email: 'buyer@example.com', key: license.key, device_id: A });

    // Another Mac cannot free Mac A's seat.
    const stranger = await h.post('/v1/deactivate', { key: license.key, device_id: B });
    expect(stranger.status).toBe(200);
    expect(stranger.body.deactivated).toBe(false);
    expect(await activeDevices(license.id)).toEqual([A]);

    expect((await h.post('/v1/deactivate', { key: license.key, device_id: A })).body.deactivated).toBe(true);
    expect((await h.post('/v1/deactivate', { key: license.key, device_id: A })).body.deactivated).toBe(false);
  });

  it('works on a revoked and on an expired license', async () => {
    const revoked = await h.newLicense('lifetime');
    await h.post('/v1/activate', { email: 'buyer@example.com', key: revoked.key, device_id: A });
    await revokeLicense(h.ctx.db, revoked.id, 'test', h.clock.now());
    expect((await h.post('/v1/deactivate', { key: revoked.key, device_id: A })).body.deactivated).toBe(true);

    const expired = await h.newLicense('monthly', { days: 1 });
    await h.post('/v1/activate', { email: 'buyer@example.com', key: expired.key, device_id: A });
    h.clock.advanceDays(2);
    expect((await h.post('/v1/deactivate', { key: expired.key, device_id: A })).body.deactivated).toBe(true);
  });

  it('lets the same Mac come back after deactivating, without a transfer', async () => {
    const license = await h.newLicense('lifetime');
    await h.post('/v1/activate', { email: 'buyer@example.com', key: license.key, device_id: A });
    await h.post('/v1/deactivate', { key: license.key, device_id: A });

    const again = await h.post('/v1/activate', { email: 'buyer@example.com', key: license.key, device_id: A });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ transferred: false, transfers_left: 2 });
    expect(await activeDevices(license.id)).toEqual([A]);
  });

  it('answers invalid_key for a wrong or unknown key', async () => {
    for (const key of ['nonsense', 'NOS-AAAAA-AAAAA-AAAAA-AAAAA']) {
      const res = await h.post('/v1/deactivate', { key, device_id: A });
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('invalid_key');
    }
  });
});
