// Activate, refresh, deactivate: the seat rules of NOTCHOS-LICENSE-PLAN.md section 2.
//
// One license has max_devices seats (1 unless the admin raised it). A seat is a row in
// activations with deactivated_at IS NULL.
//
// How concurrency is handled
//   Every function below runs in one transaction whose FIRST statement locks the licenses
//   row (SELECT ... FOR UPDATE by primary key). Two requests for the same license therefore
//   run one after the other, and the seat check and the seat write are one atomic step.
//   The seats are then read with a plain SELECT: under REPEATABLE READ the transaction's
//   snapshot is taken at its first plain read, which happens after the lock was granted, so
//   it already contains whatever the previous holder of the lock committed. Do not add a
//   read before lockLicense() inside the transaction, and keep every write on a primary
//   key: range locks on the activations index could deadlock two different licenses.
//
// A refused request is a normal return value (not an exception), so the "deny" event that
// records it is committed.

import type { TokenSigner } from '../crypto/signing.ts';
import type { Db, Tx } from '../db/pool.ts';
import { selectRows, withTransaction, write } from '../db/pool.ts';
import type { Clock } from '../lib/time.ts';
import { recordEvent } from './events.ts';
import type { LicenseRow } from './licenses.ts';
import { findLicenseIdByKey, lockLicense } from './licenses.ts';
import { recordSeatMove } from './seat-moves.ts';
import { getNumericSetting } from './settings.ts';
import type { IssuedToken } from './tokens.ts';
import { issueLicenseToken } from './tokens.ts';

export interface LicensingDeps {
  db: Db;
  signer: TokenSigner;
  clock: Clock;
}

/** What the app tells us about the Mac that is asking. */
export interface Device {
  deviceId: string;
  deviceName: string | null;
  appVersion: string | null;
  ip: string | null;
}

interface Seat {
  id: number;
  device_id: string;
  device_name: string | null;
  activated_at: Date;
  last_seen_at: Date;
}

export type ActivateOutcome =
  | ({ ok: true; licenseId: number; transferred: boolean; transfersLeft: number } & IssuedToken)
  | { ok: false; error: 'invalid_key' }
  | { ok: false; error: 'revoked' }
  | { ok: false; error: 'expired'; expiresAt: Date }
  | {
      ok: false;
      error: 'already_active' | 'transfer_limit_reached';
      /** The Mac that holds the seat a transfer would take. */
      deviceName: string | null;
      activatedAt: Date;
      transfersLeft: number;
    };

export type RefreshOutcome =
  | ({ ok: true; licenseId: number } & IssuedToken)
  | { ok: false; error: 'invalid_key' | 'revoked' | 'seat_moved' }
  | { ok: false; error: 'expired'; expiresAt: Date };

export type DeactivateOutcome = { ok: true; deactivated: boolean } | { ok: false; error: 'invalid_key' };

function expiredAt(license: LicenseRow, now: Date): Date | null {
  return license.expires_at !== null && license.expires_at.getTime() <= now.getTime() ? license.expires_at : null;
}

/** The seats in use, least recently seen first. Call only while the license row is locked. */
async function seatsInUse(tx: Tx, licenseId: number): Promise<Seat[]> {
  return selectRows<Seat>(
    tx,
    `SELECT id, device_id, device_name, activated_at, last_seen_at
       FROM activations
      WHERE license_id = ? AND deactivated_at IS NULL
      ORDER BY last_seen_at ASC, id ASC`,
    [licenseId],
  );
}

async function takeSeat(tx: Tx, licenseId: number, device: Device, now: Date): Promise<void> {
  await write(
    tx,
    `INSERT INTO activations (license_id, device_id, device_name, app_version, activated_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [licenseId, device.deviceId, device.deviceName, device.appVersion, now, now],
  );
}

async function touchSeat(tx: Tx, seatId: number, device: Device, now: Date): Promise<void> {
  // A name or version the app did not send leaves the stored one as it is.
  await write(
    tx,
    `UPDATE activations
        SET last_seen_at = ?, device_name = COALESCE(?, device_name), app_version = COALESCE(?, app_version)
      WHERE id = ?`,
    [now, device.deviceName, device.appVersion, seatId],
  );
}

/**
 * Activate a key on a device.
 *   - this device already holds a seat  -> new token, nothing else changes (reinstall)
 *   - a seat is free                    -> the device takes it
 *   - all seats are taken               -> already_active, or, with transfer = true and
 *                                          transfers left, the least recently seen Mac
 *                                          loses its seat to this device
 */
export async function activate(
  deps: LicensingDeps,
  canonicalKey: string,
  /** Already normalised (trim + lower case). Must match the license email or the call is invalid_key. */
  email: string,
  device: Device,
  transfer: boolean,
): Promise<ActivateOutcome> {
  const licenseId = await findLicenseIdByKey(deps.db, canonicalKey);
  if (licenseId === null) return { ok: false, error: 'invalid_key' };

  return withTransaction(deps.db, async (tx): Promise<ActivateOutcome> => {
    const license = await lockLicense(tx, licenseId);
    if (license === null) return { ok: false, error: 'invalid_key' };
    const now = deps.clock.now();

    const deny = (reason: string): Promise<void> =>
      recordEvent(tx, {
        licenseId,
        deviceId: device.deviceId,
        type: 'deny',
        detail: `activate: ${reason}`,
        ip: device.ip,
        at: now,
      });
    const granted = (transferred: boolean, transfersLeft: number): ActivateOutcome => ({
      ok: true,
      licenseId,
      transferred,
      transfersLeft,
      ...issueLicenseToken(deps.signer, license, device.deviceId, now),
    });

    // Wrong email looks exactly like a wrong key: never tell the client which field failed.
    if (license.email.trim().toLowerCase() !== email) {
      await deny('email_mismatch');
      return { ok: false, error: 'invalid_key' };
    }

    if (license.status === 'revoked') {
      await deny('revoked');
      return { ok: false, error: 'revoked' };
    }
    const expired = expiredAt(license, now);
    if (expired !== null) {
      await deny('expired');
      return { ok: false, error: 'expired', expiresAt: expired };
    }

    const seats = await seatsInUse(tx, licenseId);
    const transferLimit = await getNumericSetting(tx, 'transfer_limit');
    const transfersLeft = Math.max(0, transferLimit - license.transfers_used);

    const own = seats.find((seat) => seat.device_id === device.deviceId);
    if (own !== undefined) {
      await touchSeat(tx, own.id, device, now);
      await recordEvent(tx, {
        licenseId,
        deviceId: device.deviceId,
        type: 'activate',
        detail: 'same device, token issued again',
        ip: device.ip,
        at: now,
      });
      return granted(false, transfersLeft);
    }

    if (seats.length < license.max_devices) {
      await takeSeat(tx, licenseId, device, now);
      await recordEvent(tx, {
        licenseId,
        deviceId: device.deviceId,
        type: 'activate',
        detail: 'seat taken',
        ip: device.ip,
        at: now,
      });
      return granted(false, transfersLeft);
    }

    // Every seat belongs to another Mac. The one seen least recently is the one a
    // transfer replaces, and the one the app names in its "move it to this Mac?" question.
    const holder = seats[0]!;
    const refusal = {
      ok: false as const,
      deviceName: holder.device_name,
      activatedAt: holder.activated_at,
      transfersLeft,
    };
    if (!transfer) {
      await deny('already_active');
      return { ...refusal, error: 'already_active' };
    }
    if (transfersLeft === 0) {
      await deny('transfer_limit_reached');
      return { ...refusal, error: 'transfer_limit_reached' };
    }

    await write(tx, 'UPDATE activations SET deactivated_at = ? WHERE id = ?', [now, holder.id]);
    await takeSeat(tx, licenseId, device, now);
    await write(tx, 'UPDATE licenses SET transfers_used = transfers_used + 1, updated_at = ? WHERE id = ?', [
      now,
      licenseId,
    ]);
    const usedAfter = license.transfers_used + 1;
    const leftAfter = transfersLeft - 1;
    await recordEvent(tx, {
      licenseId,
      deviceId: device.deviceId,
      type: 'transfer',
      detail: `seat moved here from ${holder.device_name ?? 'another Mac'}`,
      ip: device.ip,
      at: now,
    });
    await recordSeatMove(tx, {
      licenseId,
      email: license.email,
      keyHint: license.key_hint,
      fromDeviceId: holder.device_id,
      fromDeviceName: holder.device_name,
      toDeviceId: device.deviceId,
      toDeviceName: device.deviceName,
      reason: 'user_transfer',
      transfersUsedAfter: usedAfter,
      transfersLeftAfter: leftAfter,
      actor: 'user',
      ip: device.ip,
      detail: `seat moved here from ${holder.device_name ?? 'another Mac'}`,
      at: now,
    });
    return granted(true, leftAfter);
  });
}

/**
 * A fresh token for a device that holds a seat. This is how the app learns about
 * renewals, refunds (revoked) and seat moves (seat_moved).
 */
export async function refresh(deps: LicensingDeps, canonicalKey: string, device: Device): Promise<RefreshOutcome> {
  const licenseId = await findLicenseIdByKey(deps.db, canonicalKey);
  if (licenseId === null) return { ok: false, error: 'invalid_key' };

  return withTransaction(deps.db, async (tx): Promise<RefreshOutcome> => {
    const license = await lockLicense(tx, licenseId);
    if (license === null) return { ok: false, error: 'invalid_key' };
    const now = deps.clock.now();

    const deny = (reason: string): Promise<void> =>
      recordEvent(tx, {
        licenseId,
        deviceId: device.deviceId,
        type: 'deny',
        detail: `refresh: ${reason}`,
        ip: device.ip,
        at: now,
      });

    if (license.status === 'revoked') {
      await deny('revoked');
      return { ok: false, error: 'revoked' };
    }
    // Seat before expiry: a Mac that lost its seat is told so, not asked to renew.
    const own = (await seatsInUse(tx, licenseId)).find((seat) => seat.device_id === device.deviceId);
    if (own === undefined) {
      await deny('seat_moved');
      return { ok: false, error: 'seat_moved' };
    }
    const expired = expiredAt(license, now);
    if (expired !== null) {
      await deny('expired');
      return { ok: false, error: 'expired', expiresAt: expired };
    }

    await touchSeat(tx, own.id, device, now);
    await recordEvent(tx, { licenseId, deviceId: device.deviceId, type: 'refresh', ip: device.ip, at: now });
    return { ok: true, licenseId, ...issueLicenseToken(deps.signer, license, device.deviceId, now) };
  });
}

/**
 * Free this device's seat. Works on revoked and expired licenses too, and answers
 * deactivated: false when the device held no seat, so repeating the call is harmless.
 */
export async function deactivate(
  deps: Pick<LicensingDeps, 'db' | 'clock'>,
  canonicalKey: string,
  device: Pick<Device, 'deviceId' | 'ip'>,
): Promise<DeactivateOutcome> {
  const licenseId = await findLicenseIdByKey(deps.db, canonicalKey);
  if (licenseId === null) return { ok: false, error: 'invalid_key' };

  return withTransaction(deps.db, async (tx): Promise<DeactivateOutcome> => {
    const license = await lockLicense(tx, licenseId);
    if (license === null) return { ok: false, error: 'invalid_key' };
    const now = deps.clock.now();

    const own = (await seatsInUse(tx, licenseId)).filter((seat) => seat.device_id === device.deviceId);
    for (const seat of own) {
      await write(tx, 'UPDATE activations SET deactivated_at = ? WHERE id = ?', [now, seat.id]);
    }
    if (own.length > 0) {
      const transferLimit = await getNumericSetting(tx, 'transfer_limit');
      const transfersLeft = Math.max(0, transferLimit - license.transfers_used);
      await recordEvent(tx, {
        licenseId,
        deviceId: device.deviceId,
        type: 'deactivate',
        detail: 'by this Mac',
        ip: device.ip,
        at: now,
      });
      await recordSeatMove(tx, {
        licenseId,
        email: license.email,
        keyHint: license.key_hint,
        fromDeviceId: device.deviceId,
        fromDeviceName: own[0]?.device_name ?? null,
        toDeviceId: null,
        toDeviceName: null,
        reason: 'user_deactivate',
        transfersUsedAfter: license.transfers_used,
        transfersLeftAfter: transfersLeft,
        actor: 'user',
        ip: device.ip,
        detail: 'by this Mac',
        at: now,
      });
    }
    return { ok: true, deactivated: own.length > 0 };
  });
}
