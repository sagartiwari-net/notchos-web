// Small helpers shared by the admin routes: errors, request reading, input readers, paging.

import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Clock } from '../lib/time.ts';
import type { ApiErrorName } from '../http/respond.ts';
import { sendError } from '../http/respond.ts';

/** Thrown by a handler to answer with an error object; routeHandler() turns it into the reply. */
export class AdminHttpError extends Error {
  code: ApiErrorName;
  fields: Record<string, string> | undefined;

  constructor(code: ApiErrorName, message: string, fields?: Record<string, string>) {
    super(message);
    this.name = 'AdminHttpError';
    this.code = code;
    this.fields = fields;
  }
}

/** 400 with one sentence per input name. The first sentence is also the error's message. */
export function invalid(fields: Record<string, string>): never {
  throw new AdminHttpError('bad_request', Object.values(fields)[0] ?? 'The request was refused.', fields);
}

export function conflict(message: string): never {
  throw new AdminHttpError('conflict', message);
}

export function notFound(message: string): never {
  throw new AdminHttpError('not_found', message);
}

type Handler<R extends FastifyRequest = FastifyRequest> = (request: R, reply: FastifyReply) => Promise<unknown>;

/** Wraps a handler so a thrown AdminHttpError becomes the standard error answer. */
export function routeHandler<R extends FastifyRequest = FastifyRequest>(clock: Clock, handler: Handler<R>) {
  return async (request: R, reply: FastifyReply): Promise<unknown> => {
    try {
      return await handler(request, reply);
    } catch (err) {
      if (err instanceof AdminHttpError) {
        return sendError(
          reply,
          clock,
          err.code,
          err.fields === undefined ? {} : { fields: err.fields },
          err.message,
        );
      }
      throw err;
    }
  };
}

// ---- reading the request ---------------------------------------------------------------

/** The JSON object of a POST or PUT. A missing body is {}; anything but an object is refused. */
export function bodyObject(request: FastifyRequest): Record<string, unknown> {
  const body: unknown = request.body;
  if (body === undefined || body === null) return {};
  if (typeof body !== 'object' || Array.isArray(body)) {
    throw new AdminHttpError('bad_request', 'Send a JSON object.');
  }
  return body as Record<string, unknown>;
}

export function queryText(request: FastifyRequest, name: string): string | null {
  const raw = (request.query as Record<string, unknown> | undefined)?.[name];
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed === '' ? null : trimmed;
}

export function headerText(request: FastifyRequest, name: string): string | null {
  const raw = request.headers[name];
  return typeof raw === 'string' && raw !== '' ? raw : null;
}

/** A license id from a URL. Anything that is not a plain number cannot exist: 404. */
export function idParam(request: FastifyRequest, name = 'id'): number {
  const raw = (request.params as Record<string, string | undefined>)[name];
  if (raw === undefined || !/^\d{1,15}$/.test(raw)) notFound('There is no such record.');
  return Number(raw);
}

// ---- input readers ---------------------------------------------------------------------

export const NOTE_MAX_LENGTH = 2000;
export const MAX_DEVICES_LIMIT = 100;

export function readEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const email = value.trim();
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

export function readInt(value: unknown, min: number, max: number): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max ? value : null;
}

const LATEST_DATE_MS = Date.UTC(2100, 0, 1);

/** An ISO timestamp that lies after `now`, cut to whole seconds; null when it is none of that. */
export function readFutureDate(value: unknown, now: Date): Date | null {
  if (typeof value !== 'string' || value.length > 40) return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  const seconds = Math.floor(ms / 1000) * 1000;
  return seconds > now.getTime() && seconds < LATEST_DATE_MS ? new Date(seconds) : null;
}

export function readPrice(value: unknown): string | null {
  if (typeof value !== 'string' || !/^\d{1,6}(\.\d{1,2})?$/.test(value) || Number(value) <= 0) return null;
  return Number(value).toFixed(2);
}

export function readHttpsUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 500) return null;
  try {
    return new URL(value).protocol === 'https:' ? value : null;
  } catch {
    return null;
  }
}

export function readVersion(value: unknown): string | null {
  return typeof value === 'string' && /^\d+\.\d+(\.\d+)?$/.test(value) ? value : null;
}

/** Day granularity for audit details: 2026-12-01. */
export function dateOnly(date: Date | null): string {
  return date === null ? 'none' : date.toISOString().slice(0, 10);
}

// ---- paging and searching --------------------------------------------------------------

export const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;

export interface PageRequest {
  page: number;
  pageSize: number;
  offset: number;
}

function clampInt(raw: string | null, min: number, max: number, fallback: number): number {
  const value = raw === null ? Number.NaN : Number(raw);
  return Number.isInteger(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

/** ?page= (from 1) and ?page_size= (1-100, default 50). */
export function pageRequest(request: FastifyRequest): PageRequest {
  const page = clampInt(queryText(request, 'page'), 1, 1_000_000, 1);
  const pageSize = clampInt(queryText(request, 'page_size'), 1, MAX_PAGE_SIZE, DEFAULT_PAGE_SIZE);
  return { page, pageSize, offset: (page - 1) * pageSize };
}

export function pageOf<T>(items: T[], total: number, paging: PageRequest) {
  return { items, total, page: paging.page, page_size: paging.pageSize };
}

/** Escape % _ \ so a search text is matched literally by LIKE. */
export function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}
