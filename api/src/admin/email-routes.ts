// GET /emails — email_log rows for the admin Emails page.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from '../context.ts';
import { selectOne, selectRows } from '../db/pool.ts';
import { sendOk } from '../http/respond.ts';
import { toIso } from '../lib/time.ts';
import { escapeLike, pageOf, pageRequest, queryText, routeHandler } from './http.ts';

interface EmailLogRow {
  id: number;
  license_id: number | null;
  to_email: string;
  template: string;
  status: string;
  attempts: number;
  error: string | null;
  created_at: Date;
}

export function registerEmailRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { clock, db } = ctx;
  const handle = <R extends FastifyRequest = FastifyRequest>(fn: (request: R, reply: FastifyReply) => Promise<unknown>) =>
    routeHandler<R>(clock, fn);

  app.get(
    '/emails',
    handle(async (request, reply) => {
      const q = queryText(request, 'q');
      const status = queryText(request, 'status');
      const paging = pageRequest(request);

      const where: string[] = [];
      const values: unknown[] = [];
      if (q !== null) {
        where.push('(to_email LIKE ? OR template LIKE ? OR CAST(license_id AS CHAR) LIKE ?)');
        const like = `%${escapeLike(q)}%`;
        values.push(like, like, like);
      }
      if (status !== null && status !== '') {
        where.push('status = ?');
        values.push(status);
      }
      const whereSql = where.length === 0 ? '' : `WHERE ${where.join(' AND ')}`;

      const total = await selectOne<{ total: number }>(
        db,
        `SELECT COUNT(*) AS total FROM email_log ${whereSql}`,
        values,
      );
      const rows = await selectRows<EmailLogRow>(
        db,
        `SELECT id, license_id, to_email, template, status, attempts, error, created_at
           FROM email_log ${whereSql}
          ORDER BY created_at DESC, id DESC
          LIMIT ? OFFSET ?`,
        [...values, paging.pageSize, paging.offset],
      );

      return sendOk(
        reply,
        clock,
        pageOf(
          rows.map((row) => ({
            id: Number(row.id),
            license_id: row.license_id === null ? null : Number(row.license_id),
            to_email: row.to_email,
            template: row.template,
            status: row.status,
            attempts: Number(row.attempts),
            error: row.error,
            created_at: toIso(row.created_at),
          })),
          Number(total?.total ?? 0),
          paging,
        ),
      );
    }),
  );
}
