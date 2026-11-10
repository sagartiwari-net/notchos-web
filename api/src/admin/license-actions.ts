// The changes an admin can make to one license. Each runs in a transaction with the
// license row locked (like every seat change), writes its own license event where the
// license history shows one, and writes the audit_log row in the same transaction.
// Every change sets a state or an absolute value, so repeating one changes nothing.

import type { AppContext } from '../context.ts';
import { selectOne, withTransaction, write } from '../db/pool.ts';
import type { Tx } from '../db/pool.ts';
import { recordEvent } from '../services/events.ts';
import type { LicenseRow } from '../services/licenses.ts';
import { lockLicense } from '../services/licenses.ts';
import { recordSeatMove } from '../services/seat-moves.ts';
import { getNumericSetting } from '../services/settings.ts';
import { writeAudit } from './audit.ts';
import type { AdminIdentity } from './auth.ts';
import {
  conflict,
  dateOnly,
  invalid,
  MAX_DEVICES_LIMIT,
  NOTE_MAX_LENGTH,
  notFound,
  readEmail,
  readFutureDate,
  readInt,
} from './http.ts';

export interface ActionContext {
  ctx: AppContext;
  admin: AdminIdentity;
  ip: string;
  now: Date;
}

/** What one action did, for the audit log. */
interface Outcome {
  action: string;
  detail: string | null;
}

type Action = (tx: Tx, license: LicenseRow, a: ActionContext) => Promise<Outcome>;

/** Lock the license, run the action, audit it. 404 when the license does not exist. */
export async function runLicenseAction(a: ActionContext, licenseId: number, action: Action): Promise<void> {
  await withTransaction(a.ctx.db, async (tx) => {
    const license = await lockLicense(tx, licenseId);
    if (license === null) notFound('There is no license with this id.');
    const outcome = await action(tx, license, a);
    await writeAudit(tx, {
      adminId: a.admin.id,
      action: outcome.action,
      target: `license:${licenseId}`,
      detail: outcome.detail,
      ip: a.ip,
      at: a.now,
    });
  });
}

async function seatsInUse(tx: Tx, licenseId: number): Promise<number> {
  const row = await selectOne<{ used: number }>(
    tx,
    'SELECT COUNT(*) AS used FROM activations WHERE license_id = ? AND deactivated_at IS NULL',
    [licenseId],
  );
  return Number(row?.used ?? 0);
}

/** The expiry the app enforces: the paid-through date, plus the renewal buffer while auto-renew is on. */
async function expiryFor(tx: Tx, periodEnd: Date, autoRenew: boolean): Promise<Date> {
  if (!autoRenew) return periodEnd;
  const hours = await getNumericSetting(tx, 'renewal_buffer_hours');
  return new Date(periodEnd.getTime() + hours * 3_600_000);
}

export const restore: Action = async (tx, license, a) => {
  if (license.status !== 'active') {
    await write(tx, "UPDATE licenses SET status = 'active', updated_at = ? WHERE id = ?", [a.now, license.id]);
  }
  return { action: 'license.restore', detail: license.status === 'active' ? 'already active' : null };
};

export function freeSeat(activationId: number): Action {
  return async (tx, license, a) => {
    const seat = await selectOne<{
      id: number;
      device_id: string;
      device_name: string | null;
      deactivated_at: Date | null;
    }>(
      tx,
      'SELECT id, device_id, device_name, deactivated_at FROM activations WHERE id = ? AND license_id = ?',
      [activationId, license.id],
    );
    if (seat === null) notFound('This license has no such activation.');

    const label = seat.device_name ?? 'unnamed Mac';
    if (seat.deactivated_at !== null) return { action: 'license.free_seat', detail: `${label} (already free)` };

    const by = `admin:${a.admin.username}`;
    await write(tx, 'UPDATE activations SET deactivated_at = ? WHERE id = ?', [a.now, seat.id]);
    await write(tx, 'UPDATE licenses SET updated_at = ? WHERE id = ?', [a.now, license.id]);
    await recordEvent(tx, {
      licenseId: license.id,
      deviceId: seat.device_id,
      type: 'deactivate',
      detail: `${by}: freed the seat`,
      ip: a.ip,
      at: a.now,
    });
    const transferLimit = await getNumericSetting(tx, 'transfer_limit');
    await recordSeatMove(tx, {
      licenseId: license.id,
      email: license.email,
      keyHint: license.key_hint,
      fromDeviceId: seat.device_id,
      fromDeviceName: seat.device_name,
      toDeviceId: null,
      toDeviceName: null,
      reason: 'admin_free_seat',
      transfersUsedAfter: license.transfers_used,
      transfersLeftAfter: Math.max(0, transferLimit - license.transfers_used),
      actor: 'admin',
      adminId: a.admin.id,
      ip: a.ip,
      detail: `${by}: freed 1 seat`,
      at: a.now,
    });
    return { action: 'license.free_seat', detail: label };
  };
}

export function extend(body: Record<string, unknown>): Action {
  return async (tx, license, a) => {
    if (license.plan !== 'monthly') conflict('A lifetime license has no end date to extend.');
    const periodEnd = readFutureDate(body.period_end, a.now);
    if (periodEnd === null) invalid({ period_end: 'Choose a date in the future.' });
    const current = license.period_end;
    if (current !== null && periodEnd.getTime() < current.getTime()) {
      invalid({ period_end: 'Choose a date later than the current paid-through date.' });
    }
    if (current === null || current.getTime() !== periodEnd.getTime()) {
      const expiresAt = await expiryFor(tx, periodEnd, license.auto_renew === 1);
      await write(tx, 'UPDATE licenses SET period_end = ?, expires_at = ?, updated_at = ? WHERE id = ?', [
        periodEnd,
        expiresAt,
        a.now,
        license.id,
      ]);
      await recordEvent(tx, {
        licenseId: license.id,
        deviceId: null,
        type: 'renew',
        detail: `admin:${a.admin.username}: paid through ${dateOnly(periodEnd)}`,
        ip: a.ip,
        at: a.now,
      });
    }
    return { action: 'license.extend', detail: `period_end: ${dateOnly(current)} → ${dateOnly(periodEnd)}` };
  };
}

export function changePlan(body: Record<string, unknown>): Action {
  return async (tx, license, a) => {
    if (body.plan === 'lifetime') {
      if (license.plan === 'lifetime') conflict('This license is already lifetime.');
      await write(
        tx,
        `UPDATE licenses SET plan = 'lifetime', period_end = NULL, expires_at = NULL, auto_renew = 0,
                updated_at = ? WHERE id = ?`,
        [a.now, license.id],
      );
      return { action: 'license.change_plan', detail: 'monthly → lifetime' };
    }
    if (body.plan === 'monthly') {
      if (license.plan === 'monthly') conflict('This license is already monthly. Use Extend to move its end date.');
      const periodEnd = readFutureDate(body.period_end, a.now);
      if (periodEnd === null) invalid({ period_end: 'Choose an end date in the future.' });
      await write(
        tx,
        `UPDATE licenses SET plan = 'monthly', period_end = ?, expires_at = ?, auto_renew = 0,
                updated_at = ? WHERE id = ?`,
        [periodEnd, periodEnd, a.now, license.id],
      );
      return {
        action: 'license.change_plan',
        detail: `lifetime → monthly, paid through ${dateOnly(periodEnd)}`,
      };
    }
    return invalid({ plan: 'Choose monthly or lifetime.' });
  };
}

export function setMaxDevices(body: Record<string, unknown>): Action {
  return async (tx, license, a) => {
    const value = readInt(body.max_devices, 1, MAX_DEVICES_LIMIT);
    if (value === null) invalid({ max_devices: `Enter a whole number from 1 to ${MAX_DEVICES_LIMIT}.` });
    const inUse = await seatsInUse(tx, license.id);
    if (value < inUse) {
      invalid({
        max_devices: `${inUse} ${inUse === 1 ? 'Mac holds' : 'Macs hold'} a seat on this license. Free a seat first.`,
      });
    }
    if (value !== license.max_devices) {
      await write(tx, 'UPDATE licenses SET max_devices = ?, updated_at = ? WHERE id = ?', [value, a.now, license.id]);
    }
    return { action: 'license.set_max_devices', detail: `${license.max_devices} → ${value}` };
  };
}

export function changeEmail(body: Record<string, unknown>): Action {
  return async (tx, license, a) => {
    const email = readEmail(body.email);
    if (email === null) invalid({ email: 'Enter a valid email address.' });
    if (email !== license.email) {
      await write(tx, 'UPDATE licenses SET email = ?, updated_at = ? WHERE id = ?', [email, a.now, license.id]);
    }
    return { action: 'license.change_email', detail: `${license.email} → ${email}` };
  };
}

export function setNote(body: Record<string, unknown>): Action {
  return async (tx, license, a) => {
    const raw = body.note;
    if (typeof raw !== 'string' || raw.length > NOTE_MAX_LENGTH) {
      invalid({ note: `Enter up to ${NOTE_MAX_LENGTH} characters.` });
    }
    const note = raw.trim() === '' ? null : raw.trim();
    if (note !== license.note) {
      await write(tx, 'UPDATE licenses SET note = ?, updated_at = ? WHERE id = ?', [note, a.now, license.id]);
    }
    return { action: 'license.set_note', detail: note === null ? 'note cleared' : 'note updated' };
  };
}
