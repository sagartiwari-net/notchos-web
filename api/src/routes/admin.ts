// The admin API, under /admin/* (the admin panel calls /api/* on its own hostname; Nginx
// and the dev proxy forward that to here). The public site's /api/* routes are separate.
//
//   POST /login, POST /logout    no session needed
//   everything else              needs a valid session cookie (401 not_signed_in otherwise)
//
// Every POST and PUT must come from the same site (Origin / Referer check). The route
// modules live in src/admin/; this file only wires the hooks around them.

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { registerAuditRoutes } from '../admin/audit-routes.ts';
import { clearedSessionCookie, findSession, readCookie, SESSION_COOKIE, writeComesFromSameSite } from '../admin/auth.ts';
import { registerDashboardRoutes } from '../admin/dashboard-routes.ts';
import { registerEmailRoutes } from '../admin/email-routes.ts';
import { registerLicenseRoutes } from '../admin/license-routes.ts';
import { registerPublicSessionRoutes, registerSessionInfoRoute } from '../admin/session-routes.ts';
import { registerSettingsRoutes } from '../admin/settings-routes.ts';
import { registerTrialRoutes } from '../admin/trial-routes.ts';
import type { AppContext } from '../context.ts';
import { sendError } from '../http/respond.ts';

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export const adminRoutes: FastifyPluginAsync<{ ctx: AppContext }> = async (app, { ctx }) => {
  const { clock, config, db } = ctx;

  app.decorateRequest('admin', null);

  // First: a write that does not come from this site is refused before anything else runs.
  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    if (WRITE_METHODS.has(request.method) && !writeComesFromSameSite(request, config)) {
      request.log.info({ outcome: 'admin_forbidden_origin' }, 'admin write refused');
      return sendError(reply, clock, 'forbidden');
    }
  });

  registerPublicSessionRoutes(app, ctx);

  // Everything below needs a session.
  await app.register(async (secured) => {
    secured.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
      const cookie = readCookie(request, SESSION_COOKIE);
      const identity = cookie === null ? null : await findSession(db, cookie, clock.now());
      if (identity === null) {
        if (cookie !== null) void reply.header('set-cookie', clearedSessionCookie(config));
        return sendError(reply, clock, 'not_signed_in');
      }
      request.admin = identity;
    });

    registerSessionInfoRoute(secured, ctx);
    registerDashboardRoutes(secured, ctx);
    registerLicenseRoutes(secured, ctx);
    registerTrialRoutes(secured, ctx);
    registerSettingsRoutes(secured, ctx);
    registerEmailRoutes(secured, ctx);
    registerAuditRoutes(secured, ctx);
  });
};
