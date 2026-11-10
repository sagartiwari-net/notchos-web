// The free trial (NOTCHOS-LICENSE-PLAN.md section 5, WEB plan decision 6,
// NOTCHOS-TRIAL-SEAT-PLAN.md).
//
// The trial belongs to the device. Optional email is stored for support only and does not
// unlock a second trial. The first call fixes the dates; every later call from the same
// device gets those same dates back.
//   - while the trial runs:  a signed token (new issued_at, same expires_at)
//   - after it has ended:    trial_used with the original dates and no token

import type { TokenSigner } from '../crypto/signing.ts';
import type { Db } from '../db/pool.ts';
import { isDuplicateKeyError, selectOne, withTransaction, write } from '../db/pool.ts';
import type { Clock } from '../lib/time.ts';
import { addDays } from '../lib/time.ts';
import { recordEvent } from './events.ts';
import { getNumericSetting } from './settings.ts';
import type { IssuedToken } from './tokens.ts';
import { issueTrialToken } from './tokens.ts';

export interface TrialDeps {
  db: Db;
  signer: TokenSigner;
  clock: Clock;
}

export interface TrialDevice {
  deviceId: string;
  appVersion: string | null;
  ip: string | null;
  /** Optional support email; never grants an extra trial. */
  email: string | null;
}

interface TrialRow {
  started_at: Date;
  expires_at: Date;
  email: string | null;
  lead_id: number | null;
}

export type TrialOutcome =
  | ({ ok: true; startedAt: Date; firstCall: boolean } & IssuedToken)
  | { ok: false; error: 'trial_used'; startedAt: Date; expiresAt: Date };

export async function startTrial(deps: TrialDeps, device: TrialDevice): Promise<TrialOutcome> {
  // Read before the transaction starts, so the transaction's first statement is the INSERT.
  const trialDays = await getNumericSetting(deps.db, 'trial_days');

  return withTransaction(deps.db, async (tx): Promise<TrialOutcome> => {
    const now = deps.clock.now();

    let leadId: number | null = null;
    if (device.email !== null) {
      const lead = await selectOne<{ id: number }>(tx, 'SELECT id FROM trial_leads WHERE email = ?', [device.email]);
      leadId = lead?.id ?? null;
    }

    // The primary key on device_id decides who is first. When two first calls race, the
    // second INSERT waits for the first to commit and then fails as a duplicate.
    let firstCall = false;
    try {
      await write(
        tx,
        `INSERT INTO trials (device_id, email, started_at, expires_at, app_version, ip, lead_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [device.deviceId, device.email, now, addDays(now, trialDays), device.appVersion, device.ip, leadId],
      );
      firstCall = true;
    } catch (err) {
      if (!isDuplicateKeyError(err)) throw err;
    }

    // A shared locking read returns the committed row whatever this transaction's snapshot
    // is, and does not conflict with another repeat call doing the same.
    const trial = await selectOne<TrialRow>(
      tx,
      'SELECT started_at, expires_at, email, lead_id FROM trials WHERE device_id = ? LOCK IN SHARE MODE',
      [device.deviceId],
    );
    if (trial === null) throw new Error('trial row missing after insert');

    // Fill in email / lead on a repeat call only when the row still has none.
    if (device.email !== null && trial.email === null) {
      await write(tx, 'UPDATE trials SET email = ?, lead_id = COALESCE(lead_id, ?) WHERE device_id = ?', [
        device.email,
        leadId,
        device.deviceId,
      ]);
    }

    if (firstCall && leadId !== null) {
      await write(
        tx,
        `UPDATE trial_leads
            SET converted_trial_device_id = ?, updated_at = ?
          WHERE id = ? AND converted_trial_device_id IS NULL`,
        [device.deviceId, now, leadId],
      );
    }

    if (trial.expires_at.getTime() <= now.getTime()) {
      await recordEvent(tx, {
        licenseId: null,
        deviceId: device.deviceId,
        type: 'deny',
        detail: 'trial: trial_used',
        ip: device.ip,
        at: now,
      });
      return { ok: false, error: 'trial_used', startedAt: trial.started_at, expiresAt: trial.expires_at };
    }

    await recordEvent(tx, {
      licenseId: null,
      deviceId: device.deviceId,
      type: 'trial',
      detail: firstCall ? 'started' : 'same device again, same dates',
      ip: device.ip,
      at: now,
    });
    return {
      ok: true,
      startedAt: trial.started_at,
      firstCall,
      ...issueTrialToken(deps.signer, trial, device.deviceId, now),
    };
  });
}
