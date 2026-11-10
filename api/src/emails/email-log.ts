import type { Queryable } from '../db/pool.ts';
import { write } from '../db/pool.ts';

export async function logEmail(
  q: Queryable,
  input: {
    to: string;
    template: string;
    status: 'sent' | 'failed' | 'file';
    attempts?: number;
    error?: string | null;
    licenseId?: number | null;
    createdAt: Date;
  },
): Promise<void> {
  await write(
    q,
    `INSERT INTO email_log (license_id, to_email, template, status, attempts, error, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      input.licenseId ?? null,
      input.to,
      input.template.slice(0, 32),
      input.status,
      input.attempts ?? 1,
      input.error ?? null,
      input.createdAt,
    ],
  );
}
