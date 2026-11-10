// GET /audit-log

import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.ts';
import { selectOne, selectRows } from '../db/pool.ts';
import { sendOk } from '../http/respond.ts';
import { toIso } from '../lib/time.ts';
import { pageOf, pageRequest, queryText, routeHandler } from './http.ts';

export function registerAuditRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { clock, db } = ctx;

  app.get(
    '/audit-log',
    routeHandler(clock, async (request, reply) => {
      const action = queryText(request, 'action');
      const target = queryText(request, 'target');
      const paging = pageRequest(request);
      const conditions: string[] = [];
      const values: unknown[] = [];
      if (action !== null) {
        conditions.push('a.action = ?');
        values.push(action);
      }
      if (target !== null) {
        conditions.push('a.target = ?');
        values.push(target);
      }
      const where = conditions.length === 0 ? '' : `WHERE ${conditions.join(' AND ')}`;

      const total = await selectOne<{ total: number }>(db, `SELECT COUNT(*) AS total FROM audit_log a ${where}`, values);
      const rows = await selectRows<{
        id: number;
        admin_id: number | null;
        admin_username: string | null;
        action: string;
        target: string | null;
        detail: string | null;
        ip: string | null;
        created_at: Date;
      }>(
        db,
        `SELECT a.id, a.admin_id, u.username AS admin_username, a.action, a.target, a.detail, a.ip, a.created_at
           FROM audit_log a LEFT JOIN admin_users u ON u.id = a.admin_id
           ${where}
          ORDER BY a.created_at DESC, a.id DESC LIMIT ? OFFSET ?`,
        [...values, paging.pageSize, paging.offset],
      );
      const items = rows.map((row) => ({ ...row, created_at: toIso(row.created_at) }));
      return sendOk(reply, clock, pageOf(items, Number(total?.total ?? 0), paging));
    }),
  );
}
