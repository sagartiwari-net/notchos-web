/**
 * Turns a data-module call into an HTTP request to the live admin API.
 *
 * Browser paths are under API_BASE. Vite (dev) and Apache (production) forward them to
 * the API's /admin/* routes. Session is an HttpOnly cookie (credentials: 'same-origin').
 */

import { ApiError, SERVER_ERROR_CODES, type ApiErrorCode } from './errors'

/**
 * Dev (Vite on :4311): `/api` → proxy rewrite → API `/admin`.
 * Production (same host as the site): `/admin-api` → Apache ProxyPass → API `/admin`.
 */
export const API_BASE = import.meta.env.VITE_ADMIN_API_BASE ?? '/api'

export type HttpMethod = 'GET' | 'POST' | 'PUT'

export type QueryValue = string | number | boolean | null | undefined

export interface RequestOptions {
  /** Empty strings, null, undefined and false are left out. true is sent as 1. */
  query?: Record<string, QueryValue>
  /** A JSON object. For POST and PUT it defaults to {}. */
  body?: object
}

interface WireResponse {
  status: number
  body: string
}

async function send(method: HttpMethod, url: string, body: string | undefined): Promise<WireResponse> {
  const response = await fetch(API_BASE + url, {
    method,
    credentials: 'same-origin',
    headers:
      body === undefined
        ? { Accept: 'application/json' }
        : { Accept: 'application/json', 'Content-Type': 'application/json' },
    body,
  })
  return { status: response.status, body: await response.text() }
}

function toQueryString(query: Record<string, QueryValue> | undefined): string {
  if (query === undefined) {
    return ''
  }
  const params = new URLSearchParams()
  for (const [name, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '' || value === false) {
      continue
    }
    params.set(name, value === true ? '1' : String(value))
  }
  const text = params.toString()
  return text === '' ? '' : `?${text}`
}

function codeForStatus(status: number): ApiErrorCode {
  if (status === 401) return 'not_signed_in'
  if (status === 403) return 'forbidden'
  if (status === 404) return 'not_found'
  if (status === 409) return 'conflict'
  if (status === 429) return 'rate_limited'
  if (status >= 400 && status < 500) return 'bad_request'
  return 'server_error'
}

function fallbackMessage(code: ApiErrorCode): string {
  switch (code) {
    case 'not_signed_in':
      return 'Your session has ended. Sign in again.'
    case 'invalid_credentials':
      return 'Wrong username, password or code.'
    case 'forbidden':
      return 'The server refused this request.'
    case 'rate_limited':
      return 'Too many attempts. Wait a little and try again.'
    case 'bad_request':
      return 'The server did not accept these values.'
    case 'not_found':
      return 'This record does not exist.'
    case 'conflict':
      return 'This action does not apply to the record in its current state.'
    case 'network_error':
      return 'Could not reach the server. Check the connection and try again.'
    case 'server_error':
      return 'The server could not answer. Try again in a moment.'
  }
}

function toApiError(response: WireResponse): ApiError {
  let code = codeForStatus(response.status)
  let message: string | undefined
  let fields: Record<string, string> | undefined
  let retryAfterSeconds: number | undefined
  try {
    const parsed: unknown = JSON.parse(response.body)
    if (typeof parsed === 'object' && parsed !== null) {
      const raw = parsed as { error?: unknown; message?: unknown; fields?: unknown; retry_after?: unknown }
      const known = SERVER_ERROR_CODES.find((candidate) => candidate === raw.error)
      if (known !== undefined) {
        code = known
      }
      if (typeof raw.message === 'string' && raw.message !== '') {
        message = raw.message
      }
      if (typeof raw.fields === 'object' && raw.fields !== null) {
        fields = {}
        for (const [name, text] of Object.entries(raw.fields)) {
          if (typeof text === 'string') {
            fields[name] = text
          }
        }
      }
      if (typeof raw.retry_after === 'number' && Number.isFinite(raw.retry_after) && raw.retry_after >= 0) {
        retryAfterSeconds = raw.retry_after
      }
    }
  } catch {
    // Not JSON (proxy HTML error page): keep status-based code.
  }
  return new ApiError({
    status: response.status,
    code,
    message: message ?? fallbackMessage(code),
    fields,
    retryAfterSeconds,
  })
}

export async function request<T>(method: HttpMethod, path: string, options: RequestOptions = {}): Promise<T> {
  const url = path + toQueryString(options.query)
  const body = method === 'GET' ? undefined : JSON.stringify(options.body ?? {})

  let response: WireResponse
  try {
    response = await send(method, url, body)
  } catch (cause) {
    throw new ApiError({ status: 0, code: 'network_error', message: fallbackMessage('network_error'), cause })
  }

  if (response.status < 200 || response.status >= 300) {
    throw toApiError(response)
  }
  if (response.status === 204 || response.body === '') {
    return undefined as T
  }
  try {
    return JSON.parse(response.body) as T
  } catch (cause) {
    throw new ApiError({
      status: response.status,
      code: 'server_error',
      message: 'The server sent an answer this panel could not read.',
      cause,
    })
  }
}
