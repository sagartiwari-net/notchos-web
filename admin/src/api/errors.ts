/**
 * The one error type of the data module. Every failed call rejects with an ApiError,
 * so a page can show its error state without knowing how the data was fetched.
 *
 * Wire format the server is expected to use for every non-2xx answer. It is the error
 * object the API already sends to the app (api/README.md, "Basics"), with two optional
 * additions:
 *
 *   HTTP <status>
 *   { "error": "<ApiErrorCode>",
 *     "message": "<a sentence the admin can read>",
 *     "fields": { "<input name>": "<what is wrong with it>" },     optional, with bad_request
 *     "retry_after": <seconds>,                                    optional, with rate_limited
 *     "server_time": "..." }
 *
 * Unlike the app, the admin panel does show `message` and the `fields` texts to its user
 * (the owner), so they should be plain sentences.
 */

export type ApiErrorCode =
  /** 401. No valid session. The app answers by going to the login screen. */
  | 'not_signed_in'
  /** 401, login only. Wrong username, password or code. */
  | 'invalid_credentials'
  /** 403. The request was refused (for example the Origin check on a write). */
  | 'forbidden'
  /** 429. Too many attempts. `retryAfterSeconds` says how long to wait. */
  | 'rate_limited'
  /** 400. The request body or query was refused; `fields` names the inputs. */
  | 'bad_request'
  /** 404. */
  | 'not_found'
  /** 409. The action does not apply to the current state of the record. */
  | 'conflict'
  /** 5xx, or an answer that could not be read. */
  | 'server_error'
  /** No answer at all: offline, API down, request blocked. `status` is 0. */
  | 'network_error'

/** The names a server answer may carry in "error". Other names fall back to the HTTP status. */
export const SERVER_ERROR_CODES: readonly ApiErrorCode[] = [
  'not_signed_in',
  'invalid_credentials',
  'forbidden',
  'rate_limited',
  'bad_request',
  'not_found',
  'conflict',
  'server_error',
]

export interface ApiErrorInit {
  status: number
  code: ApiErrorCode
  message: string
  fields?: Record<string, string>
  retryAfterSeconds?: number
  cause?: unknown
}

export class ApiError extends Error {
  /** HTTP status, or 0 when the request never got an answer. */
  readonly status: number
  readonly code: ApiErrorCode
  /** Per-input messages for bad_request, keyed by input name. Empty otherwise. */
  readonly fields: Readonly<Record<string, string>>
  /** With rate_limited: how many seconds to wait, if the server said. */
  readonly retryAfterSeconds: number | undefined

  constructor(init: ApiErrorInit) {
    super(init.message, init.cause === undefined ? undefined : { cause: init.cause })
    this.name = 'ApiError'
    this.status = init.status
    this.code = init.code
    this.fields = init.fields ?? {}
    this.retryAfterSeconds = init.retryAfterSeconds
  }
}

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError
}

/** True when the server said there is no valid session. */
export function isNotSignedIn(error: unknown): boolean {
  return isApiError(error) && error.code === 'not_signed_in'
}

export function isNotFound(error: unknown): boolean {
  return isApiError(error) && error.code === 'not_found'
}

/** A sentence that can be shown to the admin for any thrown value. */
export function errorMessage(error: unknown): string {
  if (isApiError(error)) {
    return error.message
  }
  return 'Something went wrong in this page. Reload and try again.'
}
