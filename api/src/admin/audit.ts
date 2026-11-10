// audit_log: who did what in the admin, and when. Never holds a key, a password or a token.

import type { Queryable } from '../db/pool.ts';
import { write } from '../db/pool.ts';

export interface AuditEntry {
  adminId: number | null;
  action: string;
  /** "license:<id>", "device:<id>", "settings" or "session". */
  target: string | null;
  detail: string | null;
  ip: string | null;
  at: Date;
}

export async function writeAudit(q: Queryable, entry: AuditEntry): Promise<void> {
  await write(
    q,
    'INSERT INTO audit_log (admin_id, action, target, detail, ip, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [
      entry.adminId,
      entry.action.slice(0, 64),
      entry.target === null ? null : entry.target.slice(0, 128),
      entry.detail === null ? null : entry.detail.slice(0, 4000),
      entry.ip === null ? null : entry.ip.slice(0, 45),
      entry.at,
    ],
  );
}
