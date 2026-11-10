/**
 * The one place where a call of the data module turns into an HTTP request.
 *
 * Phase A0: `send` hands the request to the in-browser mock (./mock/server.ts).
 * Phase W2: replace the body of `send` with the fetch call below and delete ./mock.
 * Nothing else in the admin has to change: the paths, bodies and the handling of answers
 * and errors below are already the real ones.
 *
 *   const response = await fetch(API_BASE + url, {
 *     method,
 *     credentials: 'same-origin',            // the HttpOnly session cookie
 *     headers: body === undefined
 *       ? { Accept: 'application/json' }
 *       : { Accept: 'application/json', 'Content-Type': 'application/json' },
 *     body,
 *   })
 *   return { status: response.status, body: await response.text() }
 *
 * Every call is a relative /api/... path on the admin's own hostname, so there is no API
 * hostname in the bundle, no CORS, and the cookie stays first-party (plan section 3).
 *
 * What goes over the wire follows the API's existing conventions (api/README.md):
 * - A GET has no body. A POST or PUT always sends a JSON object with
 *   Content-Type: application/json; an action without input sends {}.
 * - A 2xx answer is a JSON object (204 or an empty body is accepted too). Fields the panel
 *   does not know, such as server_time, are ignored.
 * - Anything else is an error object, see ./errors.ts.
 */

import { ApiError, SERVER_ERROR_CODES, type ApiErrorCode } from './errors'
import { mockServer } from './mock/server'

/** Prefix of every request. Vite (dev, preview) and Nginx (production) forward it to the API. */
export const API_BASE = '/api'

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
  /** The response body as text; '' when there is none. */
  body: string
}

/** `url` is the path under API_BASE with its query string, for example "/licenses?page=2". */
async function send(method: HttpMethod, url: string, body: string | undefined): Promise<WireResponse> {
  return mockServer.handle(method, url, body)
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

/** Reads { "error", "message", "fields", "retry_after" }; falls back to the HTTP status. */
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
    // Not JSON (for example an HTML error page from a proxy): keep the status-based code.
  }
  return new ApiError({
    status: response.status,
    code,
    message: message ?? fallbackMessage(code),
    fields,
    retryAfterSeconds,
  })
}

/**
 * Sends one request and returns the parsed JSON answer.
 * Rejects with an ApiError for every failure: no answer, a non-2xx status, unreadable JSON.
 */
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
