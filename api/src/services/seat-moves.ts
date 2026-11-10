// Support-first history of seat unlinks and transfers (NOTCHOS-TRIAL-SEAT-PLAN.md).
// Written alongside the existing events table; never stores a key or token.

import type { Queryable } from '../db/pool.ts';
import { write } from '../db/pool.ts';

export type SeatMoveReason = 'user_deactivate' | 'user_transfer' | 'admin_free_seat' | 'admin_revoke';
export type SeatMoveActor = 'user' | 'admin' | 'system';

export interface NewSeatMove {
  licenseId: number;
  email: string;
  keyHint: string;
  fromDeviceId: string | null;
  fromDeviceName: string | null;
  toDeviceId: string | null;
  toDeviceName: string | null;
  reason: SeatMoveReason;
  transfersUsedAfter: number;
  transfersLeftAfter: number;
  actor: SeatMoveActor;
  adminId?: number | null;
  ip?: string | null;
  detail?: string | null;
  at: Date;
}

export async function recordSeatMove(q: Queryable, move: NewSeatMove): Promise<void> {
  await write(
    q,
    `INSERT INTO seat_moves (
       license_id, email, key_hint,
       from_device_id, from_device_name, to_device_id, to_device_name,
       reason, transfers_used_after, transfers_left_after,
       actor, admin_id, ip, detail, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      move.licenseId,
      move.email.slice(0, 254),
      move.keyHint.slice(0, 4),
      move.fromDeviceId,
      move.fromDeviceName === null || move.fromDeviceName === undefined
        ? null
        : move.fromDeviceName.slice(0, 100),
      move.toDeviceId,
      move.toDeviceName === null || move.toDeviceName === undefined
        ? null
        : move.toDeviceName.slice(0, 100),
      move.reason,
      move.transfersUsedAfter,
      move.transfersLeftAfter,
      move.actor,
      move.adminId ?? null,
      move.ip == null ? null : move.ip.slice(0, 45),
      move.detail == null ? null : move.detail.slice(0, 512),
      move.at,
    ],
  );
}
