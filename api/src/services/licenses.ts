// Licenses: create, look up, lock, revoke, free seats, list.
//
// Used by the CLI now and by the admin API (W2) and PayPal fulfilment (W3) later, so
// every function takes the connection it should run on: pass a transaction to make the
// call part of a larger unit of work.

import type { LicenseKeyCipher } from '../crypto/license-key.ts';
import {
  generateLicenseKey,
  hashLicenseKey,
  licenseKeyHint,
  normalizeLicenseKey,
  safeEqual,
} from '../crypto/license-key.ts';
import type { Db, Queryable, Tx } from '../db/pool.ts';
import { duplicateKeyIndex, selectOne, selectRows, withTransaction, write } from '../db/pool.ts';
import { recordEvent } from './events.ts';
import { recordSeatMove } from './seat-moves.ts';
import { getNumericSetting } from './settings.ts';

export type LicensePlan = 'monthly' | 'lifetime';
export type LicenseStatus = 'active' | 'revoked';
export type LicenseSource = 'paypal' | 'manual';

export const LICENSE_PLANS: readonly LicensePlan[] = ['monthly', 'lifetime'];
export const LICENSE_STATUSES: readonly LicenseStatus[] = ['active', 'revoked'];

/** One row of the licenses table. */
export interface LicenseRow {
  id: number;
  key_hash: string;
  key_enc: string;
  key_hint: string;
  email: string;
  payer_id: string | null;
  plan: LicensePlan;
  status: LicenseStatus;
  max_devices: number;
  period_end: Date | null;
  expires_at: Date | null;
  auto_renew: number;
  paypal_subscription_id: string | null;
  transfers_used: number;
  source: LicenseSource;
  note: string | null;
  created_at: Date;
  updated_at: Date;
}

const LICENSE_COLUMNS = `id, key_hash, key_enc, key_hint, email, payer_id, plan, status, max_devices,
  period_end, expires_at, auto_renew, paypal_subscription_id, transfers_used, source, note,
  created_at, updated_at`;

export interface NewLicense {
  email: string;
  plan: LicensePlan;
  /** When Pro ends. Required for monthly, must be null for lifetime. */
  expiresAt: Date | null;
  source: LicenseSource;
  /** What has been paid for; defaults to expiresAt. */
  periodEnd?: Date | null;
  autoRenew?: boolean;
  payerId?: string | null;
  paypalSubscriptionId?: string | null;
  maxDevices?: number;
  note?: string | null;
}

export interface CreatedLicense {
  id: number;
  /** The key in clear text. This is the only moment it exists outside the encrypted copy. */
  key: string;
  keyHint: string;
  email: string;
  plan: LicensePlan;
  expiresAt: Date | null;
}

/**
 * Create a license with a fresh key. Runs on the given connection, so a caller can put it
 * in the same transaction as, for example, the payment row.
 */
export async function createLicense(
  q: Queryable,
  cipher: LicenseKeyCipher,
  input: NewLicense,
  now: Date,
): Promise<CreatedLicense> {
  if (input.plan === 'lifetime' && input.expiresAt !== null) {
    throw new Error('a lifetime license has no expiry date');
  }
  if (input.plan === 'monthly' && input.expiresAt === null) {
    throw new Error('a monthly license needs an expiry date');
  }
  const periodEnd = input.periodEnd === undefined ? input.expiresAt : input.periodEnd;

  // 100 random bits make a collision practically impossible; the unique index on
  // key_hash still decides, and a duplicate simply draws a new key.
  for (let attempt = 0; ; attempt++) {
    const key = generateLicenseKey();
    const keyHash = hashLicenseKey(key);
    try {
      const result = await write(
        q,
        `INSERT INTO licenses
           (key_hash, key_enc, key_hint, email, payer_id, plan, status, max_devices, period_end,
            expires_at, auto_renew, paypal_subscription_id, transfers_used, source, note,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
        [
          keyHash,
          cipher.encrypt(key, keyHash),
          licenseKeyHint(key),
          input.email,
          input.payerId ?? null,
          input.plan,
          input.maxDevices ?? 1,
          periodEnd,
          input.expiresAt,
          input.autoRenew === true ? 1 : 0,
          input.paypalSubscriptionId ?? null,
          input.source,
          input.note ?? null,
          now,
          now,
        ],
      );
      return {
        id: result.insertId,
        key,
        keyHint: licenseKeyHint(key),
        email: input.email,
        plan: input.plan,
        expiresAt: input.expiresAt,
      };
    } catch (err) {
      if (duplicateKeyIndex(err) === 'uq_licenses_key_hash' && attempt < 4) continue;
      throw err;
    }
  }
}

/**
 * The id of the license that owns this canonical key, or null. Plain read without locks:
 * call it before opening the transaction, so unknown keys cost one index lookup.
 */
export async function findLicenseIdByKey(q: Queryable, canonicalKey: string): Promise<number | null> {
  const keyHash = hashLicenseKey(canonicalKey);
  const row = await selectOne<{ id: number; key_hash: string }>(
    q,
    'SELECT id, key_hash FROM licenses WHERE key_hash = ?',
    [keyHash],
  );
  if (row === null) return null;
  // The index found the row; confirm the match in constant time on the full hash.
  return safeEqual(Buffer.from(row.key_hash, 'hex'), Buffer.from(keyHash, 'hex')) ? row.id : null;
}

/**
 * Read a license and lock its row until the transaction ends. Everything that reads or
 * writes the seats of a license does this first, which makes seat changes one at a time.
 */
export async function lockLicense(tx: Tx, id: number): Promise<LicenseRow | null> {
  return selectOne<LicenseRow>(tx, `SELECT ${LICENSE_COLUMNS} FROM licenses WHERE id = ? FOR UPDATE`, [id]);
}

export async function getLicense(q: Queryable, id: number): Promise<LicenseRow | null> {
  return selectOne<LicenseRow>(q, `SELECT ${LICENSE_COLUMNS} FROM licenses WHERE id = ?`, [id]);
}

/** Find a license from what an operator typed: its numeric id or its key. */
export async function resolveLicenseRef(q: Queryable, ref: string): Promise<number | null> {
  const trimmed = ref.trim();
  if (/^\d{1,15}$/.test(trimmed)) {
    const row = await selectOne<{ id: number }>(q, 'SELECT id FROM licenses WHERE id = ?', [Number(trimmed)]);
    return row?.id ?? null;
  }
  const key = normalizeLicenseKey(trimmed);
  return key === null ? null : findLicenseIdByKey(q, key);
}

export interface RevokeResult {
  /** False when the license was already revoked. */
  changed: boolean;
  license: LicenseRow;
}

/**
 * Force a monthly license to expire at `expiresAt` (usually `now`). Lifetime licenses are
 * refused. Used by the CLI / admin when testing expiry without waiting for the calendar.
 */
export async function expireLicense(
  db: Db,
  id: number,
  expiresAt: Date,
  by: string,
  now: Date,
): Promise<LicenseRow | null> {
  return withTransaction(db, async (tx) => {
    const license = await lockLicense(tx, id);
    if (license === null) return null;
    if (license.plan === 'lifetime') {
      throw new Error('a lifetime license has no expiry');
    }
    await write(
      tx,
      'UPDATE licenses SET expires_at = ?, period_end = ?, auto_renew = 0, updated_at = ? WHERE id = ?',
      [expiresAt, expiresAt, now, id],
    );
    await recordEvent(tx, {
      licenseId: id,
      deviceId: null,
      type: 'revoke',
      detail: `${by}: forced expiry at ${expiresAt.toISOString()}`,
      at: now,
    });
    return { ...license, expires_at: expiresAt, period_end: expiresAt, auto_renew: 0, updated_at: now };
  });
}

/** Revoke a license. The Mac loses Pro on its next refresh. Returns null for an unknown id. */
export async function revokeLicense(db: Db, id: number, by: string, now: Date): Promise<RevokeResult | null> {
  return withTransaction(db, async (tx) => {
    const license = await lockLicense(tx, id);
    if (license === null) return null;
    if (license.status === 'revoked') return { changed: false, license };

    await write(tx, "UPDATE licenses SET status = 'revoked', updated_at = ? WHERE id = ?", [now, id]);
    await recordEvent(tx, { licenseId: id, deviceId: null, type: 'revoke', detail: by, at: now });
    return { changed: true, license: { ...license, status: 'revoked', updated_at: now } };
  });
}

export interface ResetSeatsResult {
  seatsFreed: number;
  transfersReset: boolean;
}

/**
 * Free every seat of a license (support: "my Mac died"). The next activation on any Mac
 * is a normal activation and uses no transfer. Optionally also zero the transfer counter.
 * Returns null for an unknown id.
 */
export async function resetSeats(
  db: Db,
  id: number,
  options: { resetTransfers: boolean; by: string },
  now: Date,
): Promise<ResetSeatsResult | null> {
  return withTransaction(db, async (tx) => {
    const license = await lockLicense(tx, id);
    if (license === null) return null;

    // Plain read after the lock, then one write per primary key: see services/activation.ts.
    const seats = await selectRows<{ id: number; device_id: string; device_name: string | null }>(
      tx,
      'SELECT id, device_id, device_name FROM activations WHERE license_id = ? AND deactivated_at IS NULL',
      [id],
    );
    for (const seat of seats) {
      await write(tx, 'UPDATE activations SET deactivated_at = ? WHERE id = ?', [now, seat.id]);
    }
    const transfersReset = options.resetTransfers && license.transfers_used > 0;
    const usedAfter = transfersReset ? 0 : license.transfers_used;
    if (transfersReset) {
      await write(tx, 'UPDATE licenses SET transfers_used = 0, updated_at = ? WHERE id = ?', [now, id]);
    }
    if (seats.length > 0 || transfersReset) {
      const parts = [`${options.by}: freed ${seats.length} seat(s)`];
      if (transfersReset) parts.push('transfer counter reset');
      await recordEvent(tx, { licenseId: id, deviceId: null, type: 'deactivate', detail: parts.join(', '), at: now });
      const transferLimit = await getNumericSetting(tx, 'transfer_limit');
      const leftAfter = Math.max(0, transferLimit - usedAfter);
      for (const seat of seats) {
        await recordSeatMove(tx, {
          licenseId: id,
          email: license.email,
          keyHint: license.key_hint,
          fromDeviceId: seat.device_id,
          fromDeviceName: seat.device_name,
          toDeviceId: null,
          toDeviceName: null,
          reason: 'admin_free_seat',
          transfersUsedAfter: usedAfter,
          transfersLeftAfter: leftAfter,
          actor: 'admin',
          detail: parts.join(', '),
          at: now,
        });
      }
    }
    return { seatsFreed: seats.length, transfersReset };
  });
}

export interface LicenseListFilter {
  /** Part of the email address. */
  email?: string;
  status?: LicenseStatus;
  plan?: LicensePlan;
  limit: number;
}

export interface LicenseListItem {
  id: number;
  plan: LicensePlan;
  status: LicenseStatus;
  email: string;
  key_hint: string;
  expires_at: Date | null;
  max_devices: number;
  transfers_used: number;
  source: LicenseSource;
  created_at: Date;
  seats_used: number;
  /** Name of the Mac seen most recently among the seats in use. */
  device_name: string | null;
}

function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/** Newest licenses first. Never returns a key. */
export async function listLicenses(q: Queryable, filter: LicenseListFilter): Promise<LicenseListItem[]> {
  // The WHERE clause is assembled from the fixed fragments below; every value is a parameter.
  const conditions: string[] = [];
  const values: unknown[] = [];
  if (filter.email !== undefined) {
    conditions.push('l.email LIKE ?');
    values.push(`%${escapeLike(filter.email)}%`);
  }
  if (filter.status !== undefined) {
    conditions.push('l.status = ?');
    values.push(filter.status);
  }
  if (filter.plan !== undefined) {
    conditions.push('l.plan = ?');
    values.push(filter.plan);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  values.push(filter.limit);

  return selectRows<LicenseListItem>(
    q,
    `SELECT l.id, l.plan, l.status, l.email, l.key_hint, l.expires_at, l.max_devices,
            l.transfers_used, l.source, l.created_at,
            (SELECT COUNT(*) FROM activations a
              WHERE a.license_id = l.id AND a.deactivated_at IS NULL) AS seats_used,
            (SELECT a.device_name FROM activations a
              WHERE a.license_id = l.id AND a.deactivated_at IS NULL
              ORDER BY a.last_seen_at DESC, a.id DESC LIMIT 1) AS device_name
       FROM licenses l
       ${where}
      ORDER BY l.id DESC
      LIMIT ?`,
    values,
  );
}
