// What the admin sees of a license: list, detail, and the JSON shape of each record.
// Field names are the column names; dates are ISO with a Z; auto_renew is a boolean.
// key_hash and key_enc never leave the server.

import { hashLicenseKey, normalizeLicenseKey } from '../crypto/license-key.ts';
import type { Queryable } from '../db/pool.ts';
import { selectOne, selectRows } from '../db/pool.ts';
import { addDays, toIso, toIsoOrNull } from '../lib/time.ts';
import { escapeLike, pageOf } from './http.ts';
import type { PageRequest } from './http.ts';

export type LicenseState = 'active' | 'expired' | 'revoked';
export const EXPIRING_SOON_DAYS = 7;
export const LICENSE_DETAIL_EVENT_LIMIT = 200;

interface LicenseColumns {
  id: number;
  key_hint: string;
  email: string;
  payer_id: string | null;
  plan: 'monthly' | 'lifetime';
  status: 'active' | 'revoked';
  max_devices: number;
  period_end: Date | null;
  expires_at: Date | null;
  auto_renew: number;
  paypal_subscription_id: string | null;
  transfers_used: number;
  source: 'paypal' | 'manual';
  note: string | null;
  created_at: Date;
  updated_at: Date;
}

const LICENSE_SELECT = `l.id, l.key_hint, l.email, l.payer_id, l.plan, l.status, l.max_devices, l.period_end,
  l.expires_at, l.auto_renew, l.paypal_subscription_id, l.transfers_used, l.source, l.note,
  l.created_at, l.updated_at`;

/** revoked: status; expired: active but past expires_at; otherwise active. */
export function licenseState(row: { status: string; expires_at: Date | null }, now: Date): LicenseState {
  if (row.status === 'revoked') return 'revoked';
  return row.expires_at !== null && row.expires_at.getTime() <= now.getTime() ? 'expired' : 'active';
}

export function serializeLicense(row: LicenseColumns) {
  return {
    id: row.id,
    key_hint: row.key_hint,
    email: row.email,
    payer_id: row.payer_id,
    plan: row.plan,
    status: row.status,
    max_devices: row.max_devices,
    period_end: toIsoOrNull(row.period_end),
    expires_at: toIsoOrNull(row.expires_at),
    auto_renew: row.auto_renew === 1 || (row.auto_renew as unknown) === true,
    paypal_subscription_id: row.paypal_subscription_id,
    transfers_used: row.transfers_used,
    source: row.source,
    note: row.note,
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
  };
}

export interface LicenseFilters {
  q: string | null;
  plan: 'monthly' | 'lifetime' | null;
  state: LicenseState | null;
  expiring: boolean;
}

/** One search box: email contains, the 4-character key ending, a full key, payer or subscription id prefix. */
function searchCondition(q: string): { sql: string; values: unknown[] } {
  const alternatives = ['l.email LIKE ?'];
  const values: unknown[] = [`%${escapeLike(q)}%`];

  const compact = q.replace(/[\s\-\u2010-\u2015\u2212]/g, '').toUpperCase();
  if (/^[A-Z0-9]{4}$/.test(compact)) {
    alternatives.push('l.key_hint = ?');
    values.push(compact);
  }
  const key = normalizeLicenseKey(q);
  if (key !== null) {
    alternatives.push('l.key_hash = ?');
    values.push(hashLicenseKey(key));
  }
  if (q.length >= 3) {
    alternatives.push('l.payer_id LIKE ?', 'l.paypal_subscription_id LIKE ?');
    values.push(`${escapeLike(q)}%`, `${escapeLike(q)}%`);
  }
  return { sql: `(${alternatives.join(' OR ')})`, values };
}

export async function listLicensePage(q: Queryable, filters: LicenseFilters, paging: PageRequest, now: Date) {
  const conditions: string[] = [];
  const values: unknown[] = [];

  if (filters.q !== null) {
    const search = searchCondition(filters.q);
    conditions.push(search.sql);
    values.push(...search.values);
  }
  if (filters.plan !== null) {
    conditions.push('l.plan = ?');
    values.push(filters.plan);
  }
  if (filters.state === 'revoked') {
    conditions.push("l.status = 'revoked'");
  } else if (filters.state === 'expired') {
    conditions.push("l.status = 'active' AND l.expires_at IS NOT NULL AND l.expires_at <= ?");
    values.push(now);
  } else if (filters.state === 'active') {
    conditions.push("l.status = 'active' AND (l.expires_at IS NULL OR l.expires_at > ?)");
    values.push(now);
  }
  if (filters.expiring) {
    conditions.push("l.status = 'active' AND l.expires_at > ? AND l.expires_at <= ?");
    values.push(now, addDays(now, EXPIRING_SOON_DAYS));
  }
  const where = conditions.length === 0 ? '' : `WHERE ${conditions.join(' AND ')}`;

  const total = await selectOne<{ total: number }>(q, `SELECT COUNT(*) AS total FROM licenses l ${where}`, values);
  const rows = await selectRows<LicenseColumns & { seats_used: number; last_seen_at: Date | null }>(
    q,
    `SELECT ${LICENSE_SELECT},
            (SELECT COUNT(*) FROM activations a
              WHERE a.license_id = l.id AND a.deactivated_at IS NULL) AS seats_used,
            (SELECT MAX(a.last_seen_at) FROM activations a
              WHERE a.license_id = l.id AND a.deactivated_at IS NULL) AS last_seen_at
       FROM licenses l
       ${where}
      ORDER BY l.created_at DESC, l.id DESC
      LIMIT ? OFFSET ?`,
    [...values, paging.pageSize, paging.offset],
  );
  const items = rows.map((row) => ({
    ...serializeLicense(row),
    state: licenseState(row, now),
    seats_used: Number(row.seats_used),
    last_seen_at: toIsoOrNull(row.last_seen_at),
  }));
  return pageOf(items, Number(total?.total ?? 0), paging);
}

/** LicenseDetail: the license, its state, every activation and the newest events. Null for an unknown id. */
export async function licenseDetail(q: Queryable, id: number, now: Date) {
  const row = await selectOne<LicenseColumns>(q, `SELECT ${LICENSE_SELECT} FROM licenses l WHERE l.id = ?`, [id]);
  if (row === null) return null;

  const activations = await selectRows<{
    id: number;
    license_id: number;
    device_id: string;
    device_name: string | null;
    app_version: string | null;
    activated_at: Date;
    last_seen_at: Date;
    deactivated_at: Date | null;
  }>(
    q,
    `SELECT id, license_id, device_id, device_name, app_version, activated_at, last_seen_at, deactivated_at
       FROM activations WHERE license_id = ? ORDER BY activated_at DESC, id DESC`,
    [id],
  );
  const events = await selectRows<{
    id: number;
    license_id: number | null;
    device_id: string | null;
    type: string;
    detail: string | null;
    ip: string | null;
    created_at: Date;
  }>(
    q,
    `SELECT id, license_id, device_id, type, detail, ip, created_at
       FROM events WHERE license_id = ? ORDER BY id DESC LIMIT ?`,
    [id, LICENSE_DETAIL_EVENT_LIMIT],
  );
  const eventsTotal = await selectOne<{ total: number }>(
    q,
    'SELECT COUNT(*) AS total FROM events WHERE license_id = ?',
    [id],
  );

  return {
    license: serializeLicense(row),
    state: licenseState(row, now),
    activations: activations.map((a) => ({
      id: a.id,
      license_id: a.license_id,
      device_id: a.device_id,
      device_name: a.device_name,
      app_version: a.app_version,
      activated_at: toIso(a.activated_at),
      last_seen_at: toIso(a.last_seen_at),
      deactivated_at: toIsoOrNull(a.deactivated_at),
    })),
    events: events.map((e) => ({
      id: e.id,
      license_id: e.license_id,
      device_id: e.device_id,
      type: e.type,
      detail: e.detail,
      ip: e.ip,
      created_at: toIso(e.created_at),
    })),
    events_total: Number(eventsTotal?.total ?? 0),
  };
}

export async function licenseSummary(q: Queryable, id: number) {
  const row = await selectOne<LicenseColumns>(q, `SELECT ${LICENSE_SELECT} FROM licenses l WHERE l.id = ?`, [id]);
  return row === null ? null : serializeLicense(row);
}
