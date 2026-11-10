// POST /v1/activate: LICENSE plan test rows 2, 3 and 11 on the server side, plus the
// transfer limit, expired / revoked / wrong keys, extra seats and concurrent requests.

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

interface SeatRow {
  device_id: string;
  device_name: string | null;
  app_version: string | null;
  activated_at: Date;
  last_seen_at: Date;
  deactivated_at: Date | null;
}

async function seats(licenseId: number): Promise<SeatRow[]> {
  return h.sql.query<SeatRow[]>(
    `SELECT device_id, device_name, app_version, activated_at, last_seen_at, deactivated_at
       FROM activations WHERE license_id = ? ORDER BY id`,
    [licenseId],
  );
}

async function activeSeats(licenseId: number): Promise<SeatRow[]> {
  return (await seats(licenseId)).filter((seat) => seat.deactivated_at === null);
}

async function transfersUsed(licenseId: number): Promise<number> {
  const rows = await h.sql.query<{ transfers_used: number }[]>(
    'SELECT transfers_used FROM licenses WHERE id = ?',
    [licenseId],
  );
  return rows[0]!.transfers_used;
}

async function events(licenseId: number): Promise<{ type: string; detail: string | null; device_id: string | null }[]> {
  return h.sql.query('SELECT type, detail, device_id FROM events WHERE license_id = ? ORDER BY id', [licenseId]);
}

describe('activating a valid key (test row 2)', () => {
  it('refuses when the email does not match the license (same answer as a bad key)', async () => {
    const license = await h.newLicense('lifetime');
    const res = await h.post('/v1/activate', {
      email: 'wrong@example.com',
      key: license.key,
      device_id: deviceId('mac-a'),
    });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('invalid_key');
    expect(await seats(license.id)).toEqual([]);
  });

  it('returns a signed token for a lifetime key: no expiry, refresh within 30 days', async () => {
    const license = await h.newLicense('lifetime');
    const now = h.clock.now();

    const res = await h.post('/v1/activate', { email: 'buyer@example.com', key: license.key,
      device_id: deviceId('mac-a'),
      device_name: "Sagar's MacBook Pro",
      app_version: '1.0.0',
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      token: expect.any(String),
      plan: 'lifetime',
      expires_at: null,
      refresh_by: toIso(addDays(now, 30)),
      transferred: false,
      transfers_left: 2,
      server_time: toIso(now),
    });
    expect(h.payloadOf(res.body.token)).toEqual({
      kid: h.ctx.signer.kid,
      license_id: license.id,
      device_id: deviceId('mac-a'),
      plan: 'lifetime',
      issued_at: toIso(now),
      expires_at: null,
      refresh_by: toIso(addDays(now, 30)),
    });

    expect(await seats(license.id)).toEqual([
      {
        device_id: deviceId('mac-a'),
        device_name: "Sagar's MacBook Pro",
        app_version: '1.0.0',
        activated_at: now,
        last_seen_at: now,
        deactivated_at: null,
      },
    ]);
    expect(await events(license.id)).toEqual([
      { type: 'activate', detail: 'seat taken', device_id: deviceId('mac-a') },
    ]);
  });

  it('returns a token for a monthly key that ends, and must be refreshed, at the license expiry', async () => {
    const license = await h.newLicense('monthly', { days: 30 });
    const now = h.clock.now();
    const expiry = toIso(addDays(now, 30));

    const res = await h.post('/v1/activate', { email: 'buyer@example.com', key: license.key, device_id: deviceId('mac-a') });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ plan: 'monthly', expires_at: expiry, refresh_by: expiry });
    expect(h.payloadOf(res.body.token)).toMatchObject({
      license_id: license.id,
      plan: 'monthly',
      issued_at: toIso(now),
      expires_at: expiry,
      refresh_by: expiry,
    });
  });

  it('accepts the key in any spelling the buyer may paste', async () => {
    const license = await h.newLicense();
    const pasted = ` ${license.key.toLowerCase().replaceAll('-', ' ')} `;
    const res = await h.post('/v1/activate', { email: 'buyer@example.com', key: pasted, device_id: deviceId('mac-a') });
    expect(res.status).toBe(200);
  });

  it('keeps the key out of the database in clear text', async () => {
    const license = await h.newLicense();
    await h.post('/v1/activate', { email: 'buyer@example.com', key: license.key, device_id: deviceId('mac-a') });

    const stored = JSON.stringify([
      await h.sql.query('SELECT * FROM licenses WHERE id = ?', [license.id]),
      await h.sql.query('SELECT * FROM activations WHERE license_id = ?', [license.id]),
      await h.sql.query('SELECT * FROM events WHERE license_id = ?', [license.id]),
    ]);
    expect(stored).not.toContain(license.key);
    expect(stored).not.toContain(license.key.replaceAll('-', ''));
    expect(stored).toContain(license.key.slice(-4)); // only the 4-character hint
  });
});

describe('the same key on a second Mac (test row 3)', () => {
  it('is refused with already_active, the other Mac, its activation date and the transfers left', async () => {
    const license = await h.newLicense();
    const activatedAt = h.clock.now();
    await h.post('/v1/activate', { email: 'buyer@example.com', key: license.key, device_id: deviceId('mac-a'), device_name: "Sagar's MacBook Pro" });

    h.clock.advanceDays(3);
    const res = await h.post('/v1/activate', { email: 'buyer@example.com', key: license.key, device_id: deviceId('mac-b'), device_name: 'Mac mini' });

    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      error: 'already_active',
      message: expect.any(String),
      device_name: "Sagar's MacBook Pro",
      activated_at: toIso(activatedAt),
      transfers_left: 2,
      server_time: toIso(h.clock.now()),
    });
    expect(res.body.token).toBeUndefined();

    // Nothing moved: Mac A still holds the only seat.
    expect((await activeSeats(license.id)).map((seat) => seat.device_id)).toEqual([deviceId('mac-a')]);
    expect(await transfersUsed(license.id)).toBe(0);
    expect((await events(license.id)).at(-1)).toEqual({
      type: 'deny',
      detail: 'activate: already_active',
      device_id: deviceId('mac-b'),
    });
  });

  it('moves the seat with transfer: true and counts one transfer', async () => {
    const license = await h.newLicense();
    await h.post('/v1/activate', { email: 'buyer@example.com', key: license.key, device_id: deviceId('mac-a'), device_name: 'Old Mac' });
    h.clock.advanceDays(1);
    const now = h.clock.now();

    const res = await h.post('/v1/activate', { email: 'buyer@example.com', key: license.key,
      device_id: deviceId('mac-b'),
      device_name: 'New Mac',
      transfer: true,
    });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ transferred: true, transfers_left: 1, plan: 'lifetime' });
    expect(h.payloadOf(res.body.token)).toMatchObject({ license_id: license.id, device_id: deviceId('mac-b') });

    const all = await seats(license.id);
    expect(all).toHaveLength(2);
    expect(all[0]).toMatchObject({ device_id: deviceId('mac-a'), deactivated_at: now });
    expect(all[1]).toMatchObject({ device_id: deviceId('mac-b'), deactivated_at: null, activated_at: now });
    expect(await transfersUsed(license.id)).toBe(1);
    expect((await events(license.id)).at(-1)).toEqual({
      type: 'transfer',
      detail: 'seat moved here from Old Mac',
      device_id: deviceId('mac-b'),
    });

    // The old Mac is now the one that is refused.
    const back = await h.post('/v1/activate', { email: 'buyer@example.com', key: license.key, device_id: deviceId('mac-a') });
    expect(back.status).toBe(409);
    expect(back.body).toMatchObject({ error: 'already_active', device_name: 'New Mac', transfers_left: 1 });
  });

  it('uses no transfer when transfer: true is sent but the seat is free', async () => {
    const license = await h.newLicense();
    const res = await h.post('/v1/activate', { email: 'buyer@example.com', key: license.key, device_id: deviceId('mac-a'), transfer: true });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ transferred: false, transfers_left: 2 });
    expect(await transfersUsed(license.id)).toBe(0);
  });
});

describe('reinstall on the same Mac (test row 11)', () => {
  it('activates again with a new token and uses no transfer', async () => {
    const license = await h.newLicense();
    const first = await h.post('/v1/activate', { email: 'buyer@example.com', key: license.key,
      device_id: deviceId('mac-a'),
      device_name: 'MacBook',
      app_version: '1.0.0',
    });
    const activatedAt = h.clock.now();

    h.clock.advanceDays(10);
    const again = await h.post('/v1/activate', { email: 'buyer@example.com', key: license.key,
      device_id: deviceId('mac-a'),
      device_name: 'MacBook (renamed)',
      app_version: '1.1.0',
    });

    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ transferred: false, transfers_left: 2 });
    expect(again.body.token).not.toBe(first.body.token);
    expect(h.payloadOf(again.body.token)).toMatchObject({
      device_id: deviceId('mac-a'),
      issued_at: toIso(h.clock.now()),
      refresh_by: toIso(addDays(h.clock.now(), 30)),
    });

    // Still one seat, the original activation date, the newer name and version.
    expect(await seats(license.id)).toEqual([
      {
        device_id: deviceId('mac-a'),
        device_name: 'MacBook (renamed)',
        app_version: '1.1.0',
        activated_at: activatedAt,
        last_seen_at: h.clock.now(),
        deactivated_at: null,
      },
    ]);
    expect(await transfersUsed(license.id)).toBe(0);
  });

  it('still works with transfer: true and still uses no transfer', async () => {
    const license = await h.newLicense();
    await h.post('/v1/activate', { email: 'buyer@example.com', key: license.key, device_id: deviceId('mac-a') });
    const again = await h.post('/v1/activate', { email: 'buyer@example.com', key: license.key, device_id: deviceId('mac-a'), transfer: true });
    expect(again.status).toBe(200);
    expect(again.body.transferred).toBe(false);
    expect(await transfersUsed(license.id)).toBe(0);
    expect(await seats(license.id)).toHaveLength(1);
  });
});

describe('transfer limit', () => {
  it('allows transfer_limit moves (default 2) and refuses the next one', async () => {
    const license = await h.newLicense();
    const activate = (device: string, transfer: boolean) =>
      h.post('/v1/activate', { email: 'buyer@example.com', key: license.key, device_id: deviceId(device), device_name: device, transfer });

    expect((await activate('mac-a', false)).status).toBe(200);
    expect((await activate('mac-b', true)).body).toMatchObject({ transferred: true, transfers_left: 1 });
    expect((await activate('mac-c', true)).body).toMatchObject({ transferred: true, transfers_left: 0 });
    const seatDate = h.clock.now();

    h.clock.advanceDays(1);
    const refused = await activate('mac-d', true);
    expect(refused.status).toBe(409);
    expect(refused.body).toEqual({
      error: 'transfer_limit_reached',
      message: expect.any(String),
      device_name: 'mac-c',
      activated_at: toIso(seatDate),
      transfers_left: 0,
      server_time: toIso(h.clock.now()),
    });

    // Without transfer the answer is the usual one, and it says that no transfer is left.
    const plain = await activate('mac-d', false);
    expect(plain.status).toBe(409);
    expect(plain.body).toMatchObject({ error: 'already_active', device_name: 'mac-c', transfers_left: 0 });

    expect((await activeSeats(license.id)).map((seat) => seat.device_name)).toEqual(['mac-c']);
    expect(await transfersUsed(license.id)).toBe(2);
    expect((await events(license.id)).filter((event) => event.type === 'deny').map((event) => event.detail)).toEqual([
      'activate: transfer_limit_reached',
      'activate: already_active',
    ]);
  });

  it('follows the transfer_limit setting', async () => {
    const license = await h.newLicense();
    const activate = (device: string, transfer: boolean) =>
      h.post('/v1/activate', { email: 'buyer@example.com', key: license.key, device_id: deviceId(device), transfer });
    await activate('mac-a', false);

    await h.sql.query("UPDATE settings SET value = '0' WHERE name = 'transfer_limit'");
    try {
      const none = await activate('mac-b', false);
      expect(none.body).toMatchObject({ error: 'already_active', transfers_left: 0 });
      expect((await activate('mac-b', true)).body.error).toBe('transfer_limit_reached');

      await h.sql.query("UPDATE settings SET value = '1' WHERE name = 'transfer_limit'");
      expect((await activate('mac-b', true)).body).toMatchObject({ transferred: true, transfers_left: 0 });
      expect((await activate('mac-c', true)).body.error).toBe('transfer_limit_reached');
    } finally {
      await h.sql.query("UPDATE settings SET value = '2' WHERE name = 'transfer_limit'");
    }
  });
});

describe('keys that must not activate', () => {
  it('refuses an expired key and tells when it expired', async () => {
    const license = await h.newLicense('monthly', { days: 2 });
    const expiry = addDays(h.clock.now(), 2);

    // One second before the end the key still activates.
    h.clock.set(addSeconds(expiry, -1));
    const before = await h.post('/v1/activate', { email: 'buyer@example.com', key: license.key, device_id: deviceId('mac-a') });
    expect(before.status).toBe(200);
    expect(before.body.expires_at).toBe(toIso(expiry));

    // At the expiry time it is over: for a new Mac and for the Mac that holds the seat.
    h.clock.set(expiry);
    for (const device of ['mac-b', 'mac-a']) {
      const res = await h.post('/v1/activate', { email: 'buyer@example.com', key: license.key, device_id: deviceId(device), transfer: true });
      expect(res.status).toBe(403);
      expect(res.body).toEqual({
        error: 'expired',
        message: expect.any(String),
        expires_at: toIso(expiry),
        server_time: toIso(expiry),
      });
    }
    expect(await transfersUsed(license.id)).toBe(0);
  });

  it('refuses a revoked key', async () => {
    const license = await h.newLicense();
    await h.sql.query("UPDATE licenses SET status = 'revoked' WHERE id = ?", [license.id]);

    const res = await h.post('/v1/activate', { email: 'buyer@example.com', key: license.key, device_id: deviceId('mac-a') });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'revoked', message: expect.any(String), server_time: toIso(h.clock.now()) });
    expect(await seats(license.id)).toEqual([]);
  });

  it('answers a wrong key and an unknown key in exactly the same way', async () => {
    const real = await h.newLicense();
    const unknownButWellFormed = real.key.slice(0, -1) + (real.key.endsWith('A') ? 'B' : 'A');
    const eventsBefore = await h.sql.query<{ n: number }[]>('SELECT COUNT(*) AS n FROM events');

    const answers = [];
    for (const key of ['hello', '', 'NOS-12345', "' OR 1=1 --", 'x'.repeat(3000), unknownButWellFormed]) {
      const res = await h.post('/v1/activate', { email: 'buyer@example.com', key, device_id: deviceId('mac-a'), transfer: true });
      answers.push({ status: res.status, body: res.body });
    }

    for (const answer of answers) {
      expect(answer).toEqual({
        status: 404,
        body: { error: 'invalid_key', message: 'This license key is not valid.', server_time: toIso(h.clock.now()) },
      });
    }
    // Guesses leave nothing behind in the database.
    expect(await h.sql.query('SELECT COUNT(*) AS n FROM events')).toEqual(eventsBefore);
    expect(await seats(real.id)).toEqual([]);
  });
});

describe('more than one seat (max_devices)', () => {
  it('lets max_devices Macs activate and names the least recently seen one when full', async () => {
    const license = await h.newLicense('lifetime', { maxDevices: 2 });
    const activate = (device: string, transfer = false) =>
      h.post('/v1/activate', { email: 'buyer@example.com', key: license.key, device_id: deviceId(device), device_name: device, transfer });

    expect((await activate('mac-a')).status).toBe(200);
    h.clock.advanceSeconds(60);
    expect((await activate('mac-b')).body).toMatchObject({ transferred: false, transfers_left: 2 });
    expect(await activeSeats(license.id)).toHaveLength(2);

    // Mac A checks in again, so Mac B is now the one seen least recently.
    h.clock.advanceSeconds(60);
    await activate('mac-a');

    h.clock.advanceSeconds(60);
    const full = await activate('mac-c');
    expect(full.status).toBe(409);
    expect(full.body).toMatchObject({ error: 'already_active', device_name: 'mac-b', transfers_left: 2 });

    const moved = await activate('mac-c', true);
    expect(moved.body).toMatchObject({ transferred: true, transfers_left: 1 });
    expect((await activeSeats(license.id)).map((seat) => seat.device_name).sort()).toEqual(['mac-a', 'mac-c']);
  });

  it('honours a seat count raised later by the admin', async () => {
    const license = await h.newLicense();
    const activate = (device: string) => h.post('/v1/activate', { email: 'buyer@example.com', key: license.key, device_id: deviceId(device) });
    await activate('mac-a');
    expect((await activate('mac-b')).status).toBe(409);

    await h.sql.query('UPDATE licenses SET max_devices = 2 WHERE id = ?', [license.id]);
    expect((await activate('mac-b')).status).toBe(200);
    expect(await transfersUsed(license.id)).toBe(0);
  });
});

describe('requests that arrive at the same moment', () => {
  it('gives the single seat to exactly one of many Macs', async () => {
    const license = await h.newLicense();
    const results = await Promise.all(
      Array.from({ length: 12 }, (_unused, i) =>
        h.post('/v1/activate', { email: 'buyer@example.com', key: license.key, device_id: deviceId(`race-${i}`), device_name: `race-${i}` }),
      ),
    );

    expect(results.filter((res) => res.status === 200)).toHaveLength(1);
    expect(results.filter((res) => res.status === 409 && res.body.error === 'already_active')).toHaveLength(11);
    expect(await activeSeats(license.id)).toHaveLength(1);
    expect(await seats(license.id)).toHaveLength(1);
  });

  it('never creates a second seat for one Mac', async () => {
    const license = await h.newLicense();
    const results = await Promise.all(
      Array.from({ length: 12 }, () => h.post('/v1/activate', { email: 'buyer@example.com', key: license.key, device_id: deviceId('mac-a') })),
    );

    expect(results.map((res) => res.status)).toEqual(Array(12).fill(200));
    expect(await seats(license.id)).toHaveLength(1);
    expect(await transfersUsed(license.id)).toBe(0);
  });

  it('never exceeds the transfer limit', async () => {
    const license = await h.newLicense();
    await h.post('/v1/activate', { email: 'buyer@example.com', key: license.key, device_id: deviceId('mac-a') });

    const results = await Promise.all(
      Array.from({ length: 8 }, (_unused, i) =>
        h.post('/v1/activate', { email: 'buyer@example.com', key: license.key, device_id: deviceId(`mover-${i}`), transfer: true }),
      ),
    );

    expect(results.filter((res) => res.status === 200 && res.body.transferred === true)).toHaveLength(2);
    expect(results.filter((res) => res.body.error === 'transfer_limit_reached')).toHaveLength(6);
    expect(await transfersUsed(license.id)).toBe(2);
    expect(await activeSeats(license.id)).toHaveLength(1);
  });

  it('keeps different licenses independent', async () => {
    const licenses = await Promise.all(Array.from({ length: 8 }, () => h.newLicense()));
    const results = await Promise.all(
      licenses.map((license, i) => h.post('/v1/activate', { email: 'buyer@example.com', key: license.key, device_id: deviceId(`solo-${i}`) })),
    );
    expect(results.map((res) => res.status)).toEqual(Array(8).fill(200));
  });
});

describe('what the app says about the Mac', () => {
  it('stores a cleaned device name and version', async () => {
    const license = await h.newLicense();
    const res = await h.post('/v1/activate', { email: 'buyer@example.com', key: license.key,
      device_id: deviceId('mac-a'),
      device_name: `  Studio\u0000\n\u202eMac\t ${'x'.repeat(200)}`,
      app_version: ' 1.2.3 (45) ',
    });
    expect(res.status).toBe(200);

    const [seat] = await seats(license.id);
    expect(seat!.device_name).toHaveLength(100);
    expect(seat!.device_name!.startsWith('Studio Mac xxx')).toBe(true);
    expect(seat!.app_version).toBe('1.2.3 (45)');
  });

  it('keeps emoji and non-Latin names intact', async () => {
    const license = await h.newLicense();
    const name = 'सागर का MacBook 💻';
    await h.post('/v1/activate', { email: 'buyer@example.com', key: license.key, device_id: deviceId('mac-a'), device_name: name });
    const other = await h.post('/v1/activate', { email: 'buyer@example.com', key: license.key, device_id: deviceId('mac-b') });
    expect(other.body.device_name).toBe(name);
  });

  it('works without a name and version; the 409 then carries device_name: null', async () => {
    const license = await h.newLicense();
    expect((await h.post('/v1/activate', { email: 'buyer@example.com', key: license.key, device_id: deviceId('mac-a') })).status).toBe(200);
    const other = await h.post('/v1/activate', { email: 'buyer@example.com', key: license.key, device_id: deviceId('mac-b'), device_name: '   ' });
    expect(other.status).toBe(409);
    expect(other.body.device_name).toBeNull();
  });
});
