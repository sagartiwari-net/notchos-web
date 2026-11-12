// /social-submissions: list share claims, mark review, Convert to Monthly after a Lifetime buy.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from '../context.ts';
import { selectOne, selectRows, withTransaction, write } from '../db/pool.ts';
import { sendOk } from '../http/respond.ts';
import { addDays, toIso, toIsoOrNull } from '../lib/time.ts';
import { writeAudit } from './audit.ts';
import {
  bodyObject,
  conflict,
  escapeLike,
  idParam,
  invalid,
  notFound,
  pageOf,
  pageRequest,
  queryText,
  routeHandler,
} from './http.ts';

type SocialStatus =
  | 'submitted'
  | 'coupon_issued'
  | 'reviewed_ok'
  | 'reviewed_bad'
  | 'converted_monthly';

interface SocialRow {
  id: number;
  contact_email: string;
  linkedin_url: string | null;
  facebook_url: string | null;
  instagram_url: string | null;
  instagram_profile_url: string | null;
  x_url: string | null;
  networks_claimed: number;
  percent_requested: number;
  coupon_id: number | null;
  status: SocialStatus;
  admin_note: string | null;
  reviewed_at: Date | null;
  created_at: Date;
  coupon_code: string | null;
  coupon_status: string | null;
  coupon_redemptions: number | null;
  payer_email: string | null;
  license_id: number | null;
  license_plan: 'monthly' | 'lifetime' | null;
}

const SELECT = `
  SELECT s.id, s.contact_email, s.linkedin_url, s.facebook_url, s.instagram_url,
         s.instagram_profile_url, s.x_url, s.networks_claimed, s.percent_requested,
         s.coupon_id, s.status, s.admin_note, s.reviewed_at, s.created_at,
         c.code AS coupon_code, c.status AS coupon_status, c.redemption_count AS coupon_redemptions,
         r.payer_email,
         r.license_id,
         l.plan AS license_plan
    FROM social_share_submissions s
    LEFT JOIN coupons c ON c.id = s.coupon_id
    LEFT JOIN coupon_redemptions r ON r.coupon_id = s.coupon_id
    LEFT JOIN licenses l ON l.id = r.license_id`;

function serialize(row: SocialRow) {
  return {
    id: Number(row.id),
    contact_email: row.contact_email,
    linkedin_url: row.linkedin_url,
    facebook_url: row.facebook_url,
    instagram_url: row.instagram_url,
    instagram_profile_url: row.instagram_profile_url,
    x_url: row.x_url,
    networks_claimed: Number(row.networks_claimed),
    percent_requested: Number(row.percent_requested),
    coupon_id: row.coupon_id === null ? null : Number(row.coupon_id),
    coupon_code: row.coupon_code,
    coupon_status: row.coupon_status,
    coupon_redeemed: Number(row.coupon_redemptions ?? 0) > 0,
    payer_email: row.payer_email,
    license_id: row.license_id === null ? null : Number(row.license_id),
    license_plan: row.license_plan,
    status: row.status,
    admin_note: row.admin_note,
    reviewed_at: toIsoOrNull(row.reviewed_at),
    created_at: toIso(row.created_at),
  };
}

export function registerSocialRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { clock, db } = ctx;
  const handle = <R extends FastifyRequest = FastifyRequest>(fn: (request: R, reply: FastifyReply) => Promise<unknown>) =>
    routeHandler<R>(clock, fn);

  app.get(
    '/social-submissions',
    handle(async (request, reply) => {
      const status = queryText(request, 'status');
      const allowed: SocialStatus[] = [
        'submitted',
        'coupon_issued',
        'reviewed_ok',
        'reviewed_bad',
        'converted_monthly',
      ];
      if (status !== null && !(allowed as string[]).includes(status)) {
        invalid({ status: 'Unknown status filter.' });
      }
      const q = queryText(request, 'q');
      const paging = pageRequest(request);

      const where: string[] = [];
      const values: unknown[] = [];
      if (status) {
        where.push('s.status = ?');
        values.push(status);
      }
      if (q) {
        where.push('(s.contact_email LIKE ? OR c.code LIKE ? OR r.payer_email LIKE ?)');
        const like = `%${escapeLike(q)}%`;
        values.push(like, like, like);
      }
      const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

      const total = await selectOne<{ total: number }>(
        db,
        `SELECT COUNT(*) AS total
           FROM social_share_submissions s
           LEFT JOIN coupons c ON c.id = s.coupon_id
           LEFT JOIN coupon_redemptions r ON r.coupon_id = s.coupon_id
           ${whereSql}`,
        values,
      );
      const rows = await selectRows<SocialRow>(
        db,
        `${SELECT} ${whereSql} ORDER BY s.created_at DESC, s.id DESC LIMIT ? OFFSET ?`,
        [...values, paging.pageSize, paging.offset],
      );
      return sendOk(reply, clock, pageOf(rows.map(serialize), Number(total?.total ?? 0), paging));
    }),
  );

  app.post(
    '/social-submissions/:id/review',
    handle(async (request, reply) => {
      const id = idParam(request);
      const body = bodyObject(request);
      const verdict = body.verdict === 'ok' || body.verdict === 'bad' ? body.verdict : null;
      if (verdict === null) invalid({ verdict: 'Choose ok or bad.' });
      let note: string | null = null;
      if (body.note !== undefined && body.note !== null) {
        if (typeof body.note !== 'string' || body.note.length > 512) {
          invalid({ note: 'Enter up to 512 characters.' });
        }
        note = body.note.trim() === '' ? null : body.note.trim();
      }

      const now = clock.now();
      const nextStatus: SocialStatus = verdict === 'ok' ? 'reviewed_ok' : 'reviewed_bad';
      const updated = await withTransaction(db, async (tx) => {
        const row = await selectOne<SocialRow>(tx, `${SELECT} WHERE s.id = ?`, [id]);
        if (!row) notFound('Share submission not found.');
        if (row.status === 'converted_monthly') {
          conflict('This submission was already converted to Monthly.');
        }
        await write(
          tx,
          `UPDATE social_share_submissions
              SET status = ?, admin_note = COALESCE(?, admin_note), reviewed_at = ?, updated_at = ?
            WHERE id = ?`,
          [nextStatus, note, now, now, id],
        );
        if (verdict === 'bad' && row.coupon_id && Number(row.coupon_redemptions ?? 0) === 0) {
          await write(
            tx,
            `UPDATE coupons SET status = 'void', updated_at = ? WHERE id = ? AND status = 'active'`,
            [now, row.coupon_id],
          );
        }
        await writeAudit(tx, {
          adminId: request.admin!.id,
          action: 'social.review',
          target: `social:${id}`,
          detail: `${verdict}${note ? `: ${note}` : ''}`,
          ip: request.ip,
          at: now,
        });
        return selectOne<SocialRow>(tx, `${SELECT} WHERE s.id = ?`, [id]);
      });
      return sendOk(reply, clock, serialize(updated!));
    }),
  );

  app.post(
    '/social-submissions/:id/convert-monthly',
    handle(async (request, reply) => {
      const id = idParam(request);
      const body = bodyObject(request);
      let note: string | null = null;
      if (body.note !== undefined && body.note !== null) {
        if (typeof body.note !== 'string' || body.note.length > 512) {
          invalid({ note: 'Enter up to 512 characters.' });
        }
        note = body.note.trim() === '' ? null : body.note.trim();
      }

      const now = clock.now();
      const periodEnd = addDays(now, 30);

      const updated = await withTransaction(db, async (tx) => {
        const row = await selectOne<SocialRow>(tx, `${SELECT} WHERE s.id = ?`, [id]);
        if (!row) notFound('Share submission not found.');
        if (row.status === 'converted_monthly') conflict('Already converted to Monthly.');
        if (row.license_id === null) {
          conflict('No Lifetime purchase is linked to this coupon yet. Mark as bad instead, or wait for a buy.');
        }
        if (row.license_plan === 'monthly') {
          conflict('Linked license is already Monthly.');
        }

        await write(
          tx,
          `UPDATE licenses
              SET plan = 'monthly', period_end = ?, expires_at = ?, auto_renew = 0, updated_at = ?,
                  note = CONCAT(COALESCE(CONCAT(note, ' | '), ''), ?)
            WHERE id = ?`,
          [
            periodEnd,
            periodEnd,
            now,
            `converted from Lifetime (social #${id})${note ? `: ${note}` : ''}`,
            row.license_id,
          ],
        );
        await write(
          tx,
          `UPDATE social_share_submissions
              SET status = 'converted_monthly', admin_note = COALESCE(?, admin_note),
                  reviewed_at = COALESCE(reviewed_at, ?), updated_at = ?
            WHERE id = ?`,
          [note, now, now, id],
        );
        await writeAudit(tx, {
          adminId: request.admin!.id,
          action: 'social.convert_monthly',
          target: `social:${id}`,
          detail: `license ${row.license_id} → monthly through ${periodEnd.toISOString().slice(0, 10)}`,
          ip: request.ip,
          at: now,
        });
        return selectOne<SocialRow>(tx, `${SELECT} WHERE s.id = ?`, [id]);
      });

      return sendOk(reply, clock, serialize(updated!));
    }),
  );
}
