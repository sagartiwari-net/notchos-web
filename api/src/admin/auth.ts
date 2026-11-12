// Admin sessions: the cookie, the session rows, and the same-site check for writes.
//
// The cookie holds a random id (256 bits). The database only ever holds its SHA-256, so a
// copy of the table cannot be turned into a working cookie.

import { createHash, randomBytes } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import type { Config } from '../config.ts';
import type { Queryable } from '../db/pool.ts';
import { selectOne, write } from '../db/pool.ts';
import { addSeconds } from '../lib/time.ts';
import { headerText } from './http.ts';

export const SESSION_COOKIE = 'notchos_admin_session';
export const SESSION_TTL_SECONDS = 12 * 60 * 60;

/** Who is signed in, once the session cookie has been checked. */
export interface AdminIdentity {
  id: number;
  username: string;
  expiresAt: Date;
  /** SHA-256 (hex) of the session id: admin_sessions.id_hash. */
  sessionHash: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by the admin routes' auth hook; null before it ran or on public admin routes. */
    admin: AdminIdentity | null;
  }
}

export function hashSessionId(id: string): string {
  return createHash('sha256').update(id, 'utf8').digest('hex');
}

export function newSessionId(): string {
  return randomBytes(32).toString('base64url');
}

/** The value of one cookie from the Cookie header (there is no cookie plugin). */
export function readCookie(request: FastifyRequest, name: string): string | null {
  const header = headerText(request, 'cookie');
  if (header === null) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) {
      const value = part.slice(eq + 1).trim();
      // Session ids are base64url: anything else cannot be one of ours.
      return /^[A-Za-z0-9_-]{20,128}$/.test(value) ? value : null;
    }
  }
  return null;
}

/** The Set-Cookie value that stores the session id (maxAgeSeconds 0 deletes the cookie). */
export function sessionCookieHeader(config: Config, value: string, maxAgeSeconds: number): string {
  const parts = [`${SESSION_COOKIE}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${maxAgeSeconds}`];
  if (config.nodeEnv === 'production') parts.push('Secure');
  return parts.join('; ');
}

export function clearedSessionCookie(config: Config): string {
  return sessionCookieHeader(config, '', 0);
}

export async function createSession(
  q: Queryable,
  admin: { id: number },
  request: { ip: string; userAgent: string | null },
  now: Date,
): Promise<{ id: string; expiresAt: Date }> {
  const id = newSessionId();
  const expiresAt = addSeconds(now, SESSION_TTL_SECONDS);
  await write(
    q,
    'INSERT INTO admin_sessions (id_hash, admin_id, ip, user_agent, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
    [
      hashSessionId(id),
      admin.id,
      request.ip.slice(0, 45),
      request.userAgent === null ? null : request.userAgent.slice(0, 255),
      now,
      expiresAt,
    ],
  );
  return { id, expiresAt };
}

/** The signed-in admin behind a cookie value, or null (unknown or expired session). */
export async function findSession(q: Queryable, cookieValue: string, now: Date): Promise<AdminIdentity | null> {
  const sessionHash = hashSessionId(cookieValue);
  const row = await selectOne<{ admin_id: number; username: string; expires_at: Date }>(
    q,
    `SELECT s.admin_id, u.username, s.expires_at
       FROM admin_sessions s JOIN admin_users u ON u.id = s.admin_id
      WHERE s.id_hash = ? AND s.expires_at > ?`,
    [sessionHash, now],
  );
  if (row === null) return null;
  return { id: row.admin_id, username: row.username, expiresAt: row.expires_at, sessionHash };
}

// ---- same-site check for writes --------------------------------------------------------

/** "Admin.Example.com:443" -> "admin.example.com" (default ports dropped). */
function normalizeHost(host: string): string {
  return host.toLowerCase().replace(/:(80|443)$/, '');
}

function hostOfUrl(text: string): string | null {
  try {
    return normalizeHost(new URL(text).host);
  } catch {
    return null;
  }
}

function isLoopbackHost(host: string): boolean {
  const name = host.split(':')[0] ?? '';
  return name === '127.0.0.1' || name === 'localhost' || name === '::1';
}

/**
 * A browser sends Origin with every POST and PUT. The write is accepted when that host is
 * the host the request was addressed to or the host of SITE_URL. Without an Origin header
 * the Referer is used the same way. With neither, the write is refused. (The session
 * cookie is SameSite=Strict as well, so this is a second layer.)
 *
 * Local development: Vite serves the admin on :4311 and proxies /api → API :4310, so the
 * browser Origin port differs from the API Host. Loopback Origins are accepted there only.
 */
export function writeComesFromSameSite(request: FastifyRequest, config: Config): boolean {
  const allowed = new Set<string>([normalizeHost(request.host)]);
  if (config.siteUrl !== undefined) {
    const siteHost = hostOfUrl(config.siteUrl);
    if (siteHost !== null) allowed.add(siteHost);
  }
  const origin = headerText(request, 'origin');
  if (origin !== null) {
    const host = hostOfUrl(origin);
    if (host === null) return false;
    if (allowed.has(host)) return true;
    return config.nodeEnv === 'development' && isLoopbackHost(host) && isLoopbackHost(request.host);
  }
  const referer = headerText(request, 'referer');
  if (referer !== null) {
    const host = hostOfUrl(referer);
    if (host === null) return false;
    if (allowed.has(host)) return true;
    return config.nodeEnv === 'development' && isLoopbackHost(host) && isLoopbackHost(request.host);
  }
  return false;
}
