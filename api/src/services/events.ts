// The license history shown in the admin (table events).
// An event never contains a key, a token or a secret: only ids, a type and a short note.

import type { Queryable } from '../db/pool.ts';
import { write } from '../db/pool.ts';

export type EventType =
  | 'activate'
  | 'refresh'
  | 'deny'
  | 'transfer'
  | 'deactivate'
  | 'revoke'
  | 'renew'
  | 'trial';

export interface NewEvent {
  licenseId: number | null;
  deviceId: string | null;
  type: EventType;
  detail?: string | null;
  ip?: string | null;
  at: Date;
}

export async function recordEvent(q: Queryable, event: NewEvent): Promise<void> {
  await write(
    q,
    'INSERT INTO events (license_id, device_id, type, detail, ip, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [
      event.licenseId,
      event.deviceId,
      event.type,
      event.detail == null ? null : event.detail.slice(0, 255),
      event.ip == null ? null : event.ip.slice(0, 45),
      event.at,
    ],
  );
}
