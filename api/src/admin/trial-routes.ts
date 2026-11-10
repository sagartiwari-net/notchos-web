// /trials, /trial-leads, /seat-moves

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from '../context.ts';
import type { Queryable } from '../db/pool.ts';
import { selectOne, selectRows, withTransaction, write } from '../db/pool.ts';
import { sendCreated, sendOk } from '../http/respond.ts';
import { addDays, toIso, toIsoOrNull } from '../lib/time.ts';
import { recordEvent } from '../services/events.ts';
import { getNumericSetting, SETTING_RANGE } from '../services/settings.ts';
import { writeAudit } from './audit.ts';
import {
  bodyObject,
  conflict,
  escapeLike,
  invalid,
  pageOf,
  pageRequest,
  queryText,
  readEmail,
  readInt,
  routeHandler,
} from './http.ts';

const DEVICE_ID_MIN = 16;
const DEVICE_ID_MAX = 128;
const DEVICE_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const APP_VERSION_MAX = 64;

interface TrialRow {
  device_id: string;
  email: string | null;
  started_at: Date;
  expires_at: Date;
  app_version: string | null;
  ip: string | null;
  converted_license_id: number | null;
}

const TRIAL_SELECT = `SELECT t.device_id, t.email, t.started_at, t.expires_at, t.app_version, t.ip,
    (SELECT a.license_id FROM activations a
      WHERE a.device_id = t.device_id ORDER BY a.activated_at, a.id LIMIT 1) AS converted_license_id
  FROM trials t`;

function serializeTrial(row: TrialRow, now: Date) {
  return {
    device_id: row.device_id,
    email: row.email,
    started_at: toIso(row.started_at),
    expires_at: toIso(row.expires_at),
    app_version: row.app_version,
    ip: row.ip,
    state: row.expires_at.getTime() > now.getTime() ? 'active' : 'ended',
    converted_license_id: row.converted_license_id === null ? null : Number(row.converted_license_id),
  };
}

async function trialItem(q: Queryable, deviceId: string, now: Date) {
  const row = await selectOne<TrialRow>(q, `${TRIAL_SELECT} WHERE t.device_id = ?`, [deviceId]);
  return row === null ? null : serializeTrial(row, now);
}

export function registerTrialRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { clock, db } = ctx;
  const handle = <R extends FastifyRequest = FastifyRequest>(fn: (request: R, reply: FastifyReply) => Promise<unknown>) =>
    routeHandler<R>(clock, fn);

  app.get(
    '/trials',
    handle(async (request, reply) => {
      const state = queryText(request, 'state');
      if (state !== null && state !== 'active' && state !== 'ended') invalid({ state: 'Unknown status filter.' });
      const now = clock.now();
      const paging = pageRequest(request);
      const where = state === 'active' ? 'WHERE t.expires_at > ?' : state === 'ended' ? 'WHERE t.expires_at <= ?' : '';
      const values = state === null ? [] : [now];

      const total = await selectOne<{ total: number }>(db, `SELECT COUNT(*) AS total FROM trials t ${where}`, values);
      const rows = await selectRows<TrialRow>(
        db,
        `${TRIAL_SELECT} ${where} ORDER BY t.started_at DESC, t.device_id LIMIT ? OFFSET ?`,
        [...values, paging.pageSize, paging.offset],
      );
      return sendOk(reply, clock, pageOf(rows.map((row) => serializeTrial(row, now)), Number(total?.total ?? 0), paging));
    }),
  );

  // Support / testing: start or look up a trial for a device, or restart an ended one.
  // Unlike POST /v1/trial this issues no token.
  app.post(
    '/trials',
    handle(async (request, reply) => {
      const body = bodyObject(request);
      const fields: Record<string, string> = {};

      const deviceId = typeof body.device_id === 'string' ? body.device_id.trim() : '';
      if (deviceId.length < DEVICE_ID_MIN || deviceId.length > DEVICE_ID_MAX || !DEVICE_ID_PATTERN.test(deviceId)) {
        fields.device_id = `Enter ${DEVICE_ID_MIN}–${DEVICE_ID_MAX} characters from A–Z, a–z, 0–9, _ or -.`;
      }
      let appVersion: string | null = null;
      if (body.app_version !== undefined && body.app_version !== null && body.app_version !== '') {
        if (typeof body.app_version !== 'string' || body.app_version.trim().length > APP_VERSION_MAX) {
          fields.app_version = `Enter up to ${APP_VERSION_MAX} characters.`;
        } else {
          appVersion = body.app_version.trim();
        }
      }
      const range = SETTING_RANGE.trial_days;
      let days: number | null = null;
      if (body.days !== undefined && body.days !== null) {
        days = readInt(body.days, range.min, range.max);
        if (days === null) fields.days = `Enter a whole number of days from ${range.min} to ${range.max}.`;
      }
      let email: string | null = null;
      if (body.email !== undefined && body.email !== null && body.email !== '') {
        const parsed = readEmail(body.email);
        if (parsed === null) fields.email = 'Enter a valid email address.';
        else email = parsed.toLowerCase();
      }
      if (Object.keys(fields).length > 0) invalid(fields);
      const reset = body.reset === true;

      const now = clock.now();
      const admin = request.admin!;
      const by = `admin:${admin.username}`;
      const trialDays = days ?? (await getNumericSetting(db, 'trial_days'));
      const plural = `${trialDays} day${trialDays === 1 ? '' : 's'}`;
      const audit = (action: string, detail: string | null) => ({
        adminId: admin.id,
        action,
        target: `device:${deviceId}`,
        detail,
        ip: request.ip,
        at: now,
      });

      const created = await withTransaction(db, async (tx) => {
        const existing = await selectOne<{ started_at: Date; expires_at: Date; email: string | null }>(
          tx,
          'SELECT started_at, expires_at, email FROM trials WHERE device_id = ? FOR UPDATE',
          [deviceId],
        );

        if (existing !== null) {
          const active = existing.expires_at.getTime() > now.getTime();
          if (active) {
            if (email !== null && existing.email === null) {
              await write(tx, 'UPDATE trials SET email = ? WHERE device_id = ?', [email, deviceId]);
              await writeAudit(tx, audit('trial.set_email', email));
            }
            return false;
          }
          if (!reset) conflict('This Mac already used its trial. Tick “Reset if already used” to grant another.');
          const expiresAt = addDays(now, trialDays);
          await write(
            tx,
            `UPDATE trials SET started_at = ?, expires_at = ?, app_version = COALESCE(?, app_version),
                    email = COALESCE(?, email) WHERE device_id = ?`,
            [now, expiresAt, appVersion, email, deviceId],
          );
          await recordEvent(tx, {
            licenseId: null,
            deviceId,
            type: 'trial',
            detail: `${by}: trial restarted, ${plural}`,
            ip: request.ip,
            at: now,
          });
          await writeAudit(tx, audit('trial.reset', `${plural}, ends ${toIso(expiresAt)}`));
          return false;
        }

        let leadId: number | null = null;
        if (email !== null) {
          const lead = await selectOne<{ id: number }>(tx, 'SELECT id FROM trial_leads WHERE email = ?', [email]);
          leadId = lead?.id ?? null;
        }
        const expiresAt = addDays(now, trialDays);
        await write(
          tx,
          `INSERT INTO trials (device_id, email, started_at, expires_at, app_version, ip, lead_id)
           VALUES (?, ?, ?, ?, ?, NULL, ?)`,
          [deviceId, email, now, expiresAt, appVersion, leadId],
        );
        if (leadId !== null) {
          await write(
            tx,
            `UPDATE trial_leads SET converted_trial_device_id = ?, updated_at = ?
              WHERE id = ? AND converted_trial_device_id IS NULL`,
            [deviceId, now, leadId],
          );
        }
        await recordEvent(tx, {
          licenseId: null,
          deviceId,
          type: 'trial',
          detail: `${by}: trial granted, ${plural}`,
          ip: request.ip,
          at: now,
        });
        await writeAudit(tx, audit('trial.grant', `${plural}, ends ${toIso(expiresAt)}`));
        return true;
      });

      const item = (await trialItem(db, deviceId, clock.now()))!;
      return created ? sendCreated(reply, clock, item) : sendOk(reply, clock, item);
    }),
  );

  app.get(
    '/trial-leads',
    handle(async (request, reply) => {
      const q = queryText(request, 'q');
      const paging = pageRequest(request);
      const where = q === null ? '' : 'WHERE email LIKE ?';
      const values = q === null ? [] : [`%${escapeLike(q)}%`];
      const total = await selectOne<{ total: number }>(db, `SELECT COUNT(*) AS total FROM trial_leads ${where}`, values);
      const rows = await selectRows<{
        id: number;
        email: string;
        status: string;
        download_sent_at: Date | null;
        resend_count: number;
        converted_trial_device_id: string | null;
        converted_license_id: number | null;
        created_at: Date;
      }>(
        db,
        `SELECT id, email, status, download_sent_at, resend_count, converted_trial_device_id,
                converted_license_id, created_at
           FROM trial_leads ${where}
          ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
        [...values, paging.pageSize, paging.offset],
      );
      const items = rows.map((row) => ({
        id: row.id,
        email: row.email,
        status: row.status,
        download_sent_at: toIsoOrNull(row.download_sent_at),
        resend_count: row.resend_count,
        converted_trial_device_id: row.converted_trial_device_id,
        converted_license_id: row.converted_license_id,
        created_at: toIso(row.created_at),
      }));
      return sendOk(reply, clock, pageOf(items, Number(total?.total ?? 0), paging));
    }),
  );

  app.get(
    '/seat-moves',
    handle(async (request, reply) => {
      const q = queryText(request, 'q');
      const paging = pageRequest(request);
      let where = '';
      const values: unknown[] = [];
      if (q !== null) {
        const like = `%${escapeLike(q)}%`;
        const alternatives = ['email LIKE ?', 'key_hint = ?', 'from_device_id LIKE ?', 'to_device_id LIKE ?'];
        values.push(like, q, like, like);
        if (/^\d{1,15}$/.test(q)) {
          alternatives.push('license_id = ?');
          values.push(Number(q));
        }
        where = `WHERE ${alternatives.join(' OR ')}`;
      }
      const total = await selectOne<{ total: number }>(db, `SELECT COUNT(*) AS total FROM seat_moves ${where}`, values);
      const rows = await selectRows<{
        id: number;
        license_id: number;
        email: string;
        key_hint: string;
        from_device_id: string | null;
        from_device_name: string | null;
        to_device_id: string | null;
        to_device_name: string | null;
        reason: string;
        transfers_used_after: number;
        transfers_left_after: number;
        actor: string;
        detail: string | null;
        created_at: Date;
      }>(
        db,
        `SELECT id, license_id, email, key_hint, from_device_id, from_device_name, to_device_id,
                to_device_name, reason, transfers_used_after, transfers_left_after, actor, detail, created_at
           FROM seat_moves ${where}
          ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
        [...values, paging.pageSize, paging.offset],
      );
      const items = rows.map((row) => ({ ...row, created_at: toIso(row.created_at) }));
      return sendOk(reply, clock, pageOf(items, Number(total?.total ?? 0), paging));
    }),
  );
}
