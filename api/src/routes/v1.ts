// The routes the Mac app talks to: /v1/activate, /v1/refresh, /v1/deactivate, /v1/trial
// and /v1/health. The wire contract is written down in api/README.md; keep the two in step.
//
// Every POST route:
//   * accepts JSON only, at most 4 KiB, validated against a schema (unknown fields are
//     dropped, types are never coerced);
//   * is rate limited per client IP (before the body is read) and per license key, or per
//     device id for the trial;
//   * answers with server_time, whatever the outcome;
//   * never logs a key or a token.

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from '../context.ts';
import { hashLicenseKey, normalizeLicenseKey } from '../crypto/license-key.ts';
import { selectOne } from '../db/pool.ts';
import { sendError, sendOk, sendRateLimited } from '../http/respond.ts';
import { toIso, toIsoOrNull } from '../lib/time.ts';
import type { Device } from '../services/activation.ts';
import { activate, deactivate, refresh } from '../services/activation.ts';
import { startTrial } from '../services/trials.ts';

const BODY_LIMIT_BYTES = 4096;
const DEVICE_NAME_MAX = 100;
const APP_VERSION_MAX = 32;
const HEALTH_DB_TIMEOUT_MS = 2000;

// ---- request schemas -------------------------------------------------------------------

/** Any string: a wrong key must end as invalid_key, exactly like an unknown one. */
const keyField = { type: 'string' } as const;
/** The app's hashed device id. Opaque to the server, compared byte for byte. */
const deviceIdField = { type: 'string', minLength: 16, maxLength: 128, pattern: '^[A-Za-z0-9_-]+$' } as const;
/** Free text shown to people; cleaned and cut to 100 characters before it is stored. */
const deviceNameField = { type: 'string', maxLength: 255 } as const;
const appVersionField = { type: 'string', maxLength: 64 } as const;

/** PayPal / license email. Compared case-insensitively after trim; wrong value → invalid_key. */
const emailField = {
  type: 'string',
  minLength: 3,
  maxLength: 254,
  pattern: '^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$',
} as const;

const activateBody = {
  type: 'object',
  additionalProperties: false,
  required: ['key', 'email', 'device_id'],
  properties: {
    key: keyField,
    email: emailField,
    device_id: deviceIdField,
    device_name: deviceNameField,
    app_version: appVersionField,
    transfer: { type: 'boolean', default: false },
  },
} as const;

const refreshBody = {
  type: 'object',
  additionalProperties: false,
  required: ['key', 'device_id'],
  properties: {
    key: keyField,
    device_id: deviceIdField,
    device_name: deviceNameField,
    app_version: appVersionField,
  },
} as const;

const deactivateBody = {
  type: 'object',
  additionalProperties: false,
  required: ['key', 'device_id'],
  properties: { key: keyField, device_id: deviceIdField },
} as const;

const trialBody = {
  type: 'object',
  additionalProperties: false,
  required: ['device_id'],
  properties: {
    device_id: deviceIdField,
    app_version: appVersionField,
    /** Optional support email; does not grant an extra trial. */
    email: emailField,
  },
} as const;

interface ActivateBody {
  key: string;
  email: string;
  device_id: string;
  device_name?: string;
  app_version?: string;
  transfer: boolean;
}
type RefreshBody = Omit<ActivateBody, 'transfer' | 'email'>;
type DeactivateBody = Pick<ActivateBody, 'key' | 'device_id'>;
type TrialBody = Pick<ActivateBody, 'device_id' | 'app_version'> & { email?: string };

/** Same rule for every email check: trim + ASCII lower case. Never used in answers. */
export function normalizeEmail(input: string): string {
  return input.trim().toLowerCase();
}

// ---- helpers ---------------------------------------------------------------------------

// Control characters, and the invisible characters that reorder text on screen.
const UNSAFE_TEXT = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

/** Text a client sent for display: no control characters, trimmed, cut to `max` characters. */
function cleanText(value: string | undefined, max: number): string | null {
  if (value === undefined) return null;
  const cleaned = value.replace(UNSAFE_TEXT, ' ').replace(/\s+/g, ' ').trim();
  if (cleaned === '') return null;
  // Cut by code point so that an emoji is never split.
  return Array.from(cleaned).slice(0, max).join('');
}

function deviceFrom(request: FastifyRequest, body: RefreshBody): Device {
  return {
    deviceId: body.device_id,
    deviceName: cleanText(body.device_name, DEVICE_NAME_MAX),
    appVersion: cleanText(body.app_version, APP_VERSION_MAX),
    ip: request.ip,
  };
}

/** Reject when `work` has not settled within `ms` milliseconds. */
function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer within ${ms} ms`)), ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

export const v1Routes: FastifyPluginAsync<{ ctx: AppContext }> = async (app, { ctx }) => {
  const { clock, rateLimiter } = ctx;
  const limits = ctx.config.rateLimit;

  /** onRequest hook: one bucket per client IP, shared by the four POST routes. */
  const limitByIp = async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | void> => {
    const decision = rateLimiter.hit(`ip:${request.ip}`, limits.ipMax, clock.now());
    if (!decision.allowed) {
      request.log.info({ outcome: 'rate_limited', limit: 'ip' }, 'license request refused');
      return sendRateLimited(reply, clock, decision.retryAfterSec);
    }
  };

  /** True when the bucket of this key (by hash) or device is over its limit; the 429 is sent. */
  const overLimit = (request: FastifyRequest, reply: FastifyReply, bucket: string): boolean => {
    const decision = rateLimiter.hit(bucket, limits.keyMax, clock.now());
    if (decision.allowed) return false;
    request.log.info({ outcome: 'rate_limited', limit: 'key' }, 'license request refused');
    void sendRateLimited(reply, clock, decision.retryAfterSec);
    return true;
  };

  const logOutcome = (request: FastifyRequest, route: string, outcome: string, licenseId?: number): void => {
    request.log.info({ route, outcome, license_id: licenseId }, 'license request handled');
  };

  const postOptions = { bodyLimit: BODY_LIMIT_BYTES, onRequest: limitByIp };

  app.post<{ Body: ActivateBody }>(
    '/activate',
    { ...postOptions, schema: { body: activateBody } },
    async (request, reply) => {
      const key = normalizeLicenseKey(request.body.key);
      if (key === null) {
        logOutcome(request, 'activate', 'invalid_key');
        return sendError(reply, clock, 'invalid_key');
      }
      if (overLimit(request, reply, `key:${hashLicenseKey(key)}`)) return reply;

      const outcome = await activate(
        ctx,
        key,
        normalizeEmail(request.body.email),
        deviceFrom(request, request.body),
        request.body.transfer,
      );
      if (outcome.ok) {
        logOutcome(request, 'activate', outcome.transferred ? 'transferred' : 'activated', outcome.licenseId);
        return sendOk(reply, clock, {
          token: outcome.token,
          plan: outcome.plan,
          expires_at: toIsoOrNull(outcome.expiresAt),
          refresh_by: toIso(outcome.refreshBy),
          transferred: outcome.transferred,
          transfers_left: outcome.transfersLeft,
        });
      }
      logOutcome(request, 'activate', outcome.error);
      switch (outcome.error) {
        case 'expired':
          return sendError(reply, clock, 'expired', { expires_at: toIso(outcome.expiresAt) });
        case 'already_active':
        case 'transfer_limit_reached':
          return sendError(reply, clock, outcome.error, {
            device_name: outcome.deviceName,
            activated_at: toIso(outcome.activatedAt),
            transfers_left: outcome.transfersLeft,
          });
        default:
          return sendError(reply, clock, outcome.error);
      }
    },
  );

  app.post<{ Body: RefreshBody }>(
    '/refresh',
    { ...postOptions, schema: { body: refreshBody } },
    async (request, reply) => {
      const key = normalizeLicenseKey(request.body.key);
      if (key === null) {
        logOutcome(request, 'refresh', 'invalid_key');
        return sendError(reply, clock, 'invalid_key');
      }
      if (overLimit(request, reply, `key:${hashLicenseKey(key)}`)) return reply;

      const outcome = await refresh(ctx, key, deviceFrom(request, request.body));
      if (outcome.ok) {
        logOutcome(request, 'refresh', 'refreshed', outcome.licenseId);
        return sendOk(reply, clock, {
          token: outcome.token,
          plan: outcome.plan,
          expires_at: toIsoOrNull(outcome.expiresAt),
          refresh_by: toIso(outcome.refreshBy),
        });
      }
      logOutcome(request, 'refresh', outcome.error);
      if (outcome.error === 'expired') {
        return sendError(reply, clock, 'expired', { expires_at: toIso(outcome.expiresAt) });
      }
      return sendError(reply, clock, outcome.error);
    },
  );

  app.post<{ Body: DeactivateBody }>(
    '/deactivate',
    { ...postOptions, schema: { body: deactivateBody } },
    async (request, reply) => {
      const key = normalizeLicenseKey(request.body.key);
      if (key === null) {
        logOutcome(request, 'deactivate', 'invalid_key');
        return sendError(reply, clock, 'invalid_key');
      }
      if (overLimit(request, reply, `key:${hashLicenseKey(key)}`)) return reply;

      const outcome = await deactivate(ctx, key, { deviceId: request.body.device_id, ip: request.ip });
      if (!outcome.ok) {
        logOutcome(request, 'deactivate', outcome.error);
        return sendError(reply, clock, outcome.error);
      }
      logOutcome(request, 'deactivate', outcome.deactivated ? 'deactivated' : 'no_seat');
      return sendOk(reply, clock, { deactivated: outcome.deactivated });
    },
  );

  app.post<{ Body: TrialBody }>(
    '/trial',
    { ...postOptions, schema: { body: trialBody } },
    async (request, reply) => {
      if (overLimit(request, reply, `device:${request.body.device_id}`)) return reply;

      const outcome = await startTrial(ctx, {
        deviceId: request.body.device_id,
        appVersion: cleanText(request.body.app_version, APP_VERSION_MAX),
        ip: request.ip,
        email:
          typeof request.body.email === 'string' && request.body.email.trim() !== ''
            ? normalizeEmail(request.body.email)
            : null,
      });
      if (!outcome.ok) {
        logOutcome(request, 'trial', outcome.error);
        return sendError(reply, clock, 'trial_used', {
          started_at: toIso(outcome.startedAt),
          expires_at: toIso(outcome.expiresAt),
        });
      }
      logOutcome(request, 'trial', outcome.firstCall ? 'trial_started' : 'trial_repeated');
      return sendOk(reply, clock, {
        token: outcome.token,
        plan: outcome.plan,
        started_at: toIso(outcome.startedAt),
        expires_at: toIsoOrNull(outcome.expiresAt),
        refresh_by: toIso(outcome.refreshBy),
      });
    },
  );

  // For the uptime monitor: 200 only when the database answers, 503 within two seconds otherwise.
  app.get('/health', async (_request, reply) => {
    try {
      await withTimeout(selectOne(ctx.db, 'SELECT 1 AS ok'), HEALTH_DB_TIMEOUT_MS);
    } catch (err) {
      app.log.error({ err }, 'health check: database not reachable');
      return sendError(reply, clock, 'unavailable');
    }
    return sendOk(reply, clock, { status: 'ok' });
  });
};
