// /licenses: list, create, detail and the actions on one license.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from '../context.ts';
import { hashLicenseKey } from '../crypto/license-key.ts';
import { selectOne, withTransaction } from '../db/pool.ts';
import { sendCreated, sendOk } from '../http/respond.ts';
import { createLicense as createLicenseRow, revokeLicense } from '../services/licenses.ts';
import { writeAudit } from './audit.ts';
import {
  bodyObject,
  idParam,
  invalid,
  MAX_DEVICES_LIMIT,
  NOTE_MAX_LENGTH,
  notFound,
  pageRequest,
  queryText,
  readEmail,
  readFutureDate,
  readInt,
  routeHandler,
} from './http.ts';
import type { ActionContext } from './license-actions.ts';
import * as actions from './license-actions.ts';
import type { LicenseState } from './license-views.ts';
import { licenseDetail, licenseSummary, listLicensePage } from './license-views.ts';

export function registerLicenseRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { clock, db } = ctx;
  const handle = <R extends FastifyRequest = FastifyRequest>(fn: (request: R, reply: FastifyReply) => Promise<unknown>) =>
    routeHandler<R>(clock, fn);

  const actionContext = (request: FastifyRequest): ActionContext => ({
    ctx,
    admin: request.admin!,
    ip: request.ip,
    now: clock.now(),
  });

  /** Run one change, then answer with the license as it is now. */
  const answerAfter = async (request: FastifyRequest, reply: FastifyReply, action: Parameters<typeof actions.runLicenseAction>[2]) => {
    const id = idParam(request);
    await actions.runLicenseAction(actionContext(request), id, action);
    return sendOk(reply, clock, (await licenseDetail(db, id, clock.now()))!);
  };

  app.get(
    '/licenses',
    handle(async (request, reply) => {
      const plan = queryText(request, 'plan');
      const state = queryText(request, 'state');
      if (plan !== null && plan !== 'monthly' && plan !== 'lifetime') invalid({ plan: 'Unknown plan filter.' });
      if (state !== null && state !== 'active' && state !== 'expired' && state !== 'revoked') {
        invalid({ state: 'Unknown status filter.' });
      }
      const page = await listLicensePage(
        db,
        {
          q: queryText(request, 'q'),
          plan: plan as 'monthly' | 'lifetime' | null,
          state: state as LicenseState | null,
          expiring: queryText(request, 'expiring') === '1',
        },
        pageRequest(request),
        clock.now(),
      );
      return sendOk(reply, clock, page);
    }),
  );

  app.post(
    '/licenses',
    handle(async (request, reply) => {
      const body = bodyObject(request);
      const now = clock.now();
      const fields: Record<string, string> = {};

      const email = readEmail(body.email);
      if (email === null) fields.email = 'Enter a valid email address.';
      const plan = body.plan === 'monthly' || body.plan === 'lifetime' ? body.plan : null;
      if (plan === null) fields.plan = 'Choose monthly or lifetime.';

      let periodEnd: Date | null = null;
      if (plan === 'monthly') {
        periodEnd = readFutureDate(body.period_end, now);
        if (periodEnd === null) fields.period_end = 'Choose an end date in the future.';
      } else if (plan === 'lifetime' && body.period_end !== undefined && body.period_end !== null) {
        fields.period_end = 'A lifetime license has no end date.';
      }
      const maxDevices = body.max_devices === undefined ? 1 : readInt(body.max_devices, 1, MAX_DEVICES_LIMIT);
      if (maxDevices === null) fields.max_devices = `Enter a whole number from 1 to ${MAX_DEVICES_LIMIT}.`;
      let note: string | null = null;
      if (body.note !== undefined && body.note !== null) {
        if (typeof body.note !== 'string' || body.note.length > NOTE_MAX_LENGTH) {
          fields.note = `Enter up to ${NOTE_MAX_LENGTH} characters.`;
        } else {
          note = body.note.trim() === '' ? null : body.note.trim();
        }
      }
      if (email === null || plan === null || maxDevices === null || Object.keys(fields).length > 0) invalid(fields);

      const created = await withTransaction(db, async (tx) => {
        const license = await createLicenseRow(
          tx,
          ctx.keyCipher,
          { email, plan, expiresAt: periodEnd, source: 'manual', maxDevices, note },
          now,
        );
        await writeAudit(tx, {
          adminId: request.admin!.id,
          action: 'license.create',
          target: `license:${license.id}`,
          detail: `${plan}, ${email}`,
          ip: request.ip,
          at: now,
        });
        return license;
      });
      const license = await licenseSummary(db, created.id);
      return sendCreated(reply, clock, { license, key: created.key });
    }),
  );

  app.get(
    '/licenses/:id',
    handle(async (request, reply) => {
      const detail = await licenseDetail(db, idParam(request), clock.now());
      if (detail === null) notFound('There is no license with this id.');
      return sendOk(reply, clock, detail);
    }),
  );

  app.post(
    '/licenses/:id/revoke',
    handle(async (request, reply) => {
      const id = idParam(request);
      const now = clock.now();
      const result = await revokeLicense(db, id, `admin:${request.admin!.username}`, now);
      if (result === null) notFound('There is no license with this id.');
      await writeAudit(db, {
        adminId: request.admin!.id,
        action: 'license.revoke',
        target: `license:${id}`,
        detail: result.changed ? null : 'already revoked',
        ip: request.ip,
        at: now,
      });
      return sendOk(reply, clock, (await licenseDetail(db, id, clock.now()))!);
    }),
  );

  app.post(
    '/licenses/:id/restore',
    handle((request, reply) => answerAfter(request, reply, actions.restore)),
  );

  app.post(
    '/licenses/:id/activations/:activation_id/free',
    handle((request, reply) => answerAfter(request, reply, actions.freeSeat(idParam(request, 'activation_id')))),
  );

  app.post(
    '/licenses/:id/extend',
    handle((request, reply) => answerAfter(request, reply, actions.extend(bodyObject(request)))),
  );

  app.post(
    '/licenses/:id/plan',
    handle((request, reply) => answerAfter(request, reply, actions.changePlan(bodyObject(request)))),
  );

  app.post(
    '/licenses/:id/max-devices',
    handle((request, reply) => answerAfter(request, reply, actions.setMaxDevices(bodyObject(request)))),
  );

  app.post(
    '/licenses/:id/email',
    handle((request, reply) => answerAfter(request, reply, actions.changeEmail(bodyObject(request)))),
  );

  app.post(
    '/licenses/:id/note',
    handle((request, reply) => answerAfter(request, reply, actions.setNote(bodyObject(request)))),
  );

  app.post(
    '/licenses/:id/resend-key',
    handle(async (request, reply) => {
      const id = idParam(request);
      const license = await selectOne<{ email: string }>(db, 'SELECT email FROM licenses WHERE id = ?', [id]);
      if (license === null) notFound('There is no license with this id.');
      // The key email is sent from W3 on; until then the request is only recorded.
      await writeAudit(db, {
        adminId: request.admin!.id,
        action: 'license.resend_key',
        target: `license:${id}`,
        detail: license.email,
        ip: request.ip,
        at: clock.now(),
      });
      return sendOk(reply, clock, { to_email: license.email });
    }),
  );

  app.post(
    '/licenses/:id/reveal-key',
    handle(async (request, reply) => {
      const id = idParam(request);
      const row = await selectOne<{ key_hash: string; key_enc: string }>(
        db,
        'SELECT key_hash, key_enc FROM licenses WHERE id = ?',
        [id],
      );
      if (row === null) notFound('There is no license with this id.');
      // Audited before the key is returned: no reveal without a trace.
      await writeAudit(db, {
        adminId: request.admin!.id,
        action: 'license.reveal_key',
        target: `license:${id}`,
        detail: null,
        ip: request.ip,
        at: clock.now(),
      });
      const key = ctx.keyCipher.decrypt(row.key_enc, row.key_hash);
      if (hashLicenseKey(key) !== row.key_hash) throw new Error('stored key copy does not match its hash');
      return sendOk(reply, clock, { key });
    }),
  );
}
