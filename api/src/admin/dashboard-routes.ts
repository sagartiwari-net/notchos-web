// GET /dashboard: counters, all derived from the tables.

import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.ts';
import type { Queryable } from '../db/pool.ts';
import { selectOne } from '../db/pool.ts';
import { sendOk } from '../http/respond.ts';
import { addDays } from '../lib/time.ts';
import { queryText, routeHandler } from './http.ts';

const HOUR_MS = 3_600_000;

/** Where "today" starts: the admin's local midnight if it lies in the last 26 hours, else midnight UTC. */
export function todayStart(requested: string | null, now: Date): Date {
  const utcMidnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  if (requested === null) return utcMidnight;
  const ms = Date.parse(requested);
  if (Number.isFinite(ms) && ms <= now.getTime() && ms > now.getTime() - 26 * HOUR_MS) {
    return new Date(Math.floor(ms / 1000) * 1000);
  }
  return utcMidnight;
}

/** A decimal string from the database (or a number) as "29.99". */
function money(value: unknown): string {
  return (Math.round(Number(value ?? 0) * 100) / 100).toFixed(2);
}

async function salesSince(q: Queryable, since: Date) {
  const row = await selectOne<{ count: number; amount: string | null }>(
    q,
    `SELECT COUNT(*) AS count, SUM(amount) AS amount FROM payments
      WHERE kind <> 'refund' AND status = 'completed' AND created_at >= ?`,
    [since],
  );
  return { count: Number(row?.count ?? 0), amount: money(row?.amount) };
}

export function registerDashboardRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { clock, db } = ctx;

  app.get(
    '/dashboard',
    routeHandler(clock, async (request, reply) => {
      const now = clock.now();
      const since30 = addDays(now, -30);

      const currencyRow = await selectOne<{ currency: string }>(
        db,
        'SELECT currency FROM payments ORDER BY id DESC LIMIT 1',
      );
      const licenses = await selectOne<{ monthly: unknown; lifetime: unknown; subscribers: unknown }>(
        db,
        `SELECT COALESCE(SUM(plan = 'monthly'), 0) AS monthly,
                COALESCE(SUM(plan = 'lifetime'), 0) AS lifetime,
                COALESCE(SUM(plan = 'monthly' AND auto_renew = 1), 0) AS subscribers
           FROM licenses
          WHERE status = 'active' AND (expires_at IS NULL OR expires_at > ?)`,
        [now],
      );
      const trials = await selectOne<{
        active: unknown;
        started_30: unknown;
        converted_30: unknown;
        started_total: unknown;
        converted_total: unknown;
      }>(
        db,
        `SELECT COALESCE(SUM(expires_at > ?), 0) AS active,
                COALESCE(SUM(started_at >= ?), 0) AS started_30,
                COALESCE(SUM(converted = 1 AND started_at >= ?), 0) AS converted_30,
                COUNT(*) AS started_total,
                COALESCE(SUM(converted = 1), 0) AS converted_total
           FROM (SELECT t.expires_at, t.started_at,
                        EXISTS (SELECT 1 FROM activations a WHERE a.device_id = t.device_id) AS converted
                   FROM trials t) x`,
        [now, since30, since30],
      );
      const failedEmails = await selectOne<{ n: number }>(
        db,
        "SELECT COUNT(*) AS n FROM email_log WHERE status = 'failed'",
      );
      const webhooks = await selectOne<{ n: number }>(
        db,
        'SELECT COUNT(*) AS n FROM webhook_events WHERE result IS NULL',
      );

      return sendOk(reply, clock, {
        currency: currencyRow?.currency ?? 'USD',
        sales: {
          today: await salesSince(db, todayStart(queryText(request, 'today_start'), now)),
          last_7_days: await salesSince(db, addDays(now, -7)),
          last_30_days: await salesSince(db, since30),
        },
        active_licenses: { monthly: Number(licenses?.monthly ?? 0), lifetime: Number(licenses?.lifetime ?? 0) },
        monthly_subscribers: Number(licenses?.subscribers ?? 0),
        trials: {
          active: Number(trials?.active ?? 0),
          started_30_days: Number(trials?.started_30 ?? 0),
          converted_30_days: Number(trials?.converted_30 ?? 0),
          started_total: Number(trials?.started_total ?? 0),
          converted_total: Number(trials?.converted_total ?? 0),
        },
        failed_emails: Number(failedEmails?.n ?? 0),
        unprocessed_webhooks: Number(webhooks?.n ?? 0),
        // Disputes are not tracked by any table yet (W3).
        open_disputes: 0,
      });
    }),
  );
}
