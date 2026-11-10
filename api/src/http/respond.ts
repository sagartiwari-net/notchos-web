// The shape of every JSON answer, and the list of error names.
//
//   success  HTTP 200  { ...fields, "server_time": "2026-11-10T03:00:00Z" }
//   error    HTTP 4xx/5xx  { "error": "<name>", "message": "<English, for developers>",
//                            ...fields, "server_time": "..." }
//
// server_time is in every answer, errors and rate-limit answers included, so the app can
// compare its clock with the server's. Clients act on the HTTP status and on "error";
// "message" is not a contract and is never shown to users as is.

import type { FastifyReply } from 'fastify';
import type { Clock } from '../lib/time.ts';
import { toIso } from '../lib/time.ts';

export const API_ERRORS = {
  // The request itself
  bad_request: { status: 400, message: 'The request body is missing a field or has a wrong value.' },
  not_found: { status: 404, message: 'No such route.' },
  payload_too_large: { status: 413, message: 'The request body is too large.' },
  unsupported_media_type: { status: 415, message: 'Send JSON with Content-Type: application/json.' },
  rate_limited: { status: 429, message: 'Too many requests. Try again later.' },

  // The admin API (W2)
  not_signed_in: { status: 401, message: 'Sign in to continue.' },
  invalid_credentials: { status: 401, message: 'Wrong username, password or code.' },
  forbidden: { status: 403, message: 'The server refused this request.' },
  conflict: { status: 409, message: 'This action does not apply to the record in its current state.' },

  // The license (names from NOTCHOS-LICENSE-PLAN.md)
  invalid_key: { status: 404, message: 'This license key is not valid.' },
  revoked: { status: 403, message: 'This license has been revoked.' },
  expired: { status: 403, message: 'This license has expired.' },
  already_active: { status: 409, message: 'This license is active on another Mac.' },
  transfer_limit_reached: {
    status: 409,
    message: 'This license is active on another Mac and has no transfers left.',
  },
  seat_moved: { status: 409, message: 'This Mac no longer holds the seat of this license.' },
  trial_used: { status: 409, message: 'The free trial on this Mac has ended.' },

  // The server
  server_error: { status: 500, message: 'The server could not handle the request.' },
  unavailable: { status: 503, message: 'The server is not ready.' },
} as const;

export type ApiErrorName = keyof typeof API_ERRORS;

export function sendOk(reply: FastifyReply, clock: Clock, body: Record<string, unknown>): FastifyReply {
  return reply.code(200).send({ ...body, server_time: toIso(clock.now()) });
}

/** HTTP 201 with the same body shape as sendOk (a created record). */
export function sendCreated(reply: FastifyReply, clock: Clock, body: Record<string, unknown>): FastifyReply {
  return reply.code(201).send({ ...body, server_time: toIso(clock.now()) });
}

export function sendError(
  reply: FastifyReply,
  clock: Clock,
  name: ApiErrorName,
  fields: Record<string, unknown> = {},
  message?: string,
): FastifyReply {
  const definition = API_ERRORS[name];
  return reply.code(definition.status).send({
    error: name,
    message: message ?? definition.message,
    ...fields,
    server_time: toIso(clock.now()),
  });
}

export function sendRateLimited(reply: FastifyReply, clock: Clock, retryAfterSec: number): FastifyReply {
  void reply.header('retry-after', String(retryAfterSec));
  return sendError(reply, clock, 'rate_limited', { retry_after: retryAfterSec });
}
