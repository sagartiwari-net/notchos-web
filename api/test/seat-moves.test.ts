// seat_moves rows for deactivate, transfer, and admin free-seat.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resetSeats } from '../src/services/licenses.ts';
import type { Harness } from './helpers/harness.ts';
import { createHarness, deviceId } from './helpers/harness.ts';

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h.close();
});

const A = deviceId('seat-move-a');
const B = deviceId('seat-move-b');

interface SeatMoveRow {
  reason: string;
  from_device_id: string | null;
  to_device_id: string | null;
  email: string;
  key_hint: string;
  actor: string;
  transfers_used_after: number;
  transfers_left_after: number;
}

async function moves(licenseId: number): Promise<SeatMoveRow[]> {
  return h.sql.query(
    `SELECT reason, from_device_id, to_device_id, email, key_hint, actor,
            transfers_used_after, transfers_left_after
       FROM seat_moves WHERE license_id = ? ORDER BY id`,
    [licenseId],
  );
}

describe('seat_moves', () => {
  it('records user_deactivate when Settings frees the seat', async () => {
    const license = await h.newLicense('lifetime');
    await h.post('/v1/activate', { email: 'buyer@example.com', key: license.key, device_id: A });

    const res = await h.post('/v1/deactivate', { key: license.key, device_id: A });
    expect(res.status).toBe(200);

    expect(await moves(license.id)).toEqual([
      {
        reason: 'user_deactivate',
        from_device_id: A,
        to_device_id: null,
        email: 'buyer@example.com',
        key_hint: license.keyHint,
        actor: 'user',
        transfers_used_after: 0,
        transfers_left_after: 2,
      },
    ]);
  });

  it('records user_transfer when the seat moves to another Mac', async () => {
    const license = await h.newLicense('lifetime');
    await h.post('/v1/activate', {
      email: 'buyer@example.com',
      key: license.key,
      device_id: A,
      device_name: 'Old Mac',
    });
    const moved = await h.post('/v1/activate', {
      email: 'buyer@example.com',
      key: license.key,
      device_id: B,
      device_name: 'New Mac',
      transfer: true,
    });
    expect(moved.status).toBe(200);

    expect(await moves(license.id)).toEqual([
      {
        reason: 'user_transfer',
        from_device_id: A,
        to_device_id: B,
        email: 'buyer@example.com',
        key_hint: license.keyHint,
        actor: 'user',
        transfers_used_after: 1,
        transfers_left_after: 1,
      },
    ]);
  });

  it('records admin_free_seat when CLI / admin frees the seat', async () => {
    const license = await h.newLicense('lifetime');
    await h.post('/v1/activate', { email: 'buyer@example.com', key: license.key, device_id: A });

    const result = await resetSeats(h.ctx.db, license.id, { resetTransfers: false, by: 'admin:test' }, h.clock.now());
    expect(result?.seatsFreed).toBe(1);

    expect(await moves(license.id)).toEqual([
      {
        reason: 'admin_free_seat',
        from_device_id: A,
        to_device_id: null,
        email: 'buyer@example.com',
        key_hint: license.keyHint,
        actor: 'admin',
        transfers_used_after: 0,
        transfers_left_after: 2,
      },
    ]);
  });
});
