// POST /login, POST /logout, GET /session

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from '../context.ts';
import { DUMMY_PASSWORD_HASH, verifyPassword } from '../crypto/password.ts';
import { totpSecretAad } from '../crypto/secret-box.ts';
import { verifyTotp } from '../crypto/totp.ts';
import { selectOne, withTransaction, write } from '../db/pool.ts';
import { sendError, sendOk, sendRateLimited } from '../http/respond.ts';
import { RateLimiter } from '../lib/rate-limit.ts';
import { toIso } from '../lib/time.ts';
import { writeAudit } from './audit.ts';
import {
  clearedSessionCookie,
  createSession,
  findSession,
  readCookie,
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  sessionCookieHeader,
} from './auth.ts';
import type { AdminIdentity } from './auth.ts';
import { bodyObject, headerText } from './http.ts';

const LOGIN_MAX_ATTEMPTS = 5;
const LOGIN_WINDOW_SEC = 15 * 60;
const USERNAME_MAX_LENGTH = 64;
const PASSWORD_MAX_LENGTH = 200;

interface AdminUserRow {
  id: number;
  username: string;
  password_hash: string;
  totp_secret_enc: string;
}

export function sessionBody(admin: AdminIdentity | { id: number; username: string; expiresAt: Date }) {
  return { admin: { id: admin.id, username: admin.username }, expires_at: toIso(admin.expiresAt) };
}

/** Routes that work without a session. `requireAdmin` guards the one that needs it. */
export function registerPublicSessionRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { clock, config, db } = ctx;
  // The shared limiter counts per minute; the login limit is per 15 minutes, so it has its own.
  const loginLimiter = new RateLimiter(LOGIN_WINDOW_SEC);

  app.post('/login', async (request: FastifyRequest, reply: FastifyReply) => {
    const now = clock.now();
    const decision = loginLimiter.hit(`admin-login:${request.ip}`, LOGIN_MAX_ATTEMPTS, now);
    if (!decision.allowed) return sendRateLimited(reply, clock, decision.retryAfterSec);

    const body = bodyObject(request);
    const username = typeof body.username === 'string' ? body.username.trim() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    const code = typeof body.code === 'string' ? body.code.trim() : '';
    const wellFormed =
      username !== '' &&
      username.length <= USERNAME_MAX_LENGTH &&
      password !== '' &&
      password.length <= PASSWORD_MAX_LENGTH &&
      /^\d{6}$/.test(code);

    const user = wellFormed
      ? await selectOne<AdminUserRow>(
          db,
          'SELECT id, username, password_hash, totp_secret_enc FROM admin_users WHERE username = ?',
          [username],
        )
      : null;

    // Password and code are always both checked, for an unknown user too (against dummy
    // values), so the answer and its timing do not say which part was wrong.
    const passwordOk = await verifyPassword(wellFormed ? password : '', user?.password_hash ?? DUMMY_PASSWORD_HASH);
    let totpOk = false;
    try {
      const secret =
        user === null ? Buffer.alloc(20) : ctx.secretBox.decrypt(user.totp_secret_enc, totpSecretAad(user.username));
      totpOk = verifyTotp(secret, wellFormed ? code : '', now) && user !== null;
    } catch {
      request.log.error({ outcome: 'admin_totp_unreadable' }, 'admin TOTP secret could not be decrypted');
    }
    if (user === null || !passwordOk || !totpOk) return sendError(reply, clock, 'invalid_credentials');

    const session = await withTransaction(db, async (tx) => {
      await write(tx, 'DELETE FROM admin_sessions WHERE expires_at <= ?', [now]);
      const created = await createSession(
        tx,
        user,
        { ip: request.ip, userAgent: headerText(request, 'user-agent') },
        now,
      );
      await write(tx, 'UPDATE admin_users SET last_login_at = ? WHERE id = ?', [now, user.id]);
      await writeAudit(tx, {
        adminId: user.id,
        action: 'login',
        target: 'session',
        detail: null,
        ip: request.ip,
        at: now,
      });
      return created;
    });

    void reply.header('set-cookie', sessionCookieHeader(config, session.id, SESSION_TTL_SECONDS));
    return sendOk(reply, clock, sessionBody({ id: user.id, username: user.username, expiresAt: session.expiresAt }));
  });

  app.post('/logout', async (request: FastifyRequest, reply: FastifyReply) => {
    const now = clock.now();
    const cookie = readCookie(request, SESSION_COOKIE);
    if (cookie !== null) {
      const identity = await findSession(db, cookie, now);
      if (identity !== null) {
        await withTransaction(db, async (tx) => {
          await write(tx, 'DELETE FROM admin_sessions WHERE id_hash = ?', [identity.sessionHash]);
          await writeAudit(tx, {
            adminId: identity.id,
            action: 'logout',
            target: 'session',
            detail: null,
            ip: request.ip,
            at: now,
          });
        });
      }
    }
    // Signed in or not, the browser ends up without the cookie.
    void reply.header('set-cookie', clearedSessionCookie(config));
    return sendOk(reply, clock, {});
  });
}

export function registerSessionInfoRoute(app: FastifyInstance, ctx: AppContext): void {
  app.get('/session', async (request: FastifyRequest, reply: FastifyReply) => {
    return sendOk(reply, ctx.clock, sessionBody(request.admin!));
  });
}
