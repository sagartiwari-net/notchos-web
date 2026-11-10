/**
 * Every call the admin panel makes, with the HTTP request it stands for.
 * This file is the contract that W2 builds the admin API from.
 *
 * Conventions for all of them. Where the API already has a convention for the app's routes
 * (api/README.md, "Wire contract"), the admin routes are expected to use the same one.
 *
 * - Paths are under /api on the admin's own hostname. The dev proxy and Nginx forward
 *   /api/<path> to the API's /admin/<path>.
 * - Requests: a GET has no body. A POST or PUT sends a JSON object with
 *   Content-Type: application/json; an action without input sends {}.
 * - Answers: 2xx with a JSON object. Extra fields such as server_time are ignored.
 *   Field names are the section 4 column names (snake_case). Dates are ISO 8601 UTC with
 *   whole seconds ("2026-11-10T03:36:27Z"). Money is a decimal string ("29.99").
 *   auto_renew is a JSON boolean.
 * - The session is an HttpOnly cookie set by POST /api/login; the browser never sees a token.
 * - Any call without a valid session answers 401 { "error": "not_signed_in" };
 *   the app then shows the login screen.
 * - Errors: non-2xx with { "error": "<name>", "message": "...", "fields"?: {...},
 *   "retry_after"?: seconds }, see ./errors.ts. `fields` is keyed by input name, with dots
 *   for nested inputs ("prices.monthly"). The panel shows `message` and the `fields` texts
 *   to the admin, so they should be plain sentences.
 * - Writes are recorded in audit_log by the server. License changes set a state or an
 *   absolute value, so repeating one changes nothing. The exceptions are creating a
 *   license (a new key every time) and resend-key (another email every time).
 * - List answers are { items, total, page, page_size }; page starts at 1; page_size is 25,
 *   50 or 100 (default 50).
 */

import { isNotSignedIn } from './errors'
import { request } from './transport'
import type {
  AuditLogEntry,
  AuditLogParams,
  ChangeEmailInput,
  ChangePlanInput,
  CreatedLicense,
  CreateLicenseInput,
  DashboardCounters,
  DashboardParams,
  ExtendLicenseInput,
  LicenseDetail,
  LicenseListItem,
  LicenseListParams,
  LoginInput,
  Page,
  ResendKeyResult,
  RevealedKey,
  Session,
  SetMaxDevicesInput,
  SetNoteInput,
  Settings,
  SettingsUpdate,
  CreateTrialInput,
  EmailLogItem,
  SeatMove,
  TrialLead,
  TrialListItem,
  TrialListParams,
} from './types'

/**
 * Where the data comes from. 'mock' while the module answers from memory (phase A0);
 * W2 sets this to 'live'. The app frame uses it to say so on screen.
 */
export const dataSource: 'mock' | 'live' = 'live'

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

/**
 * POST /api/login
 * Body:   { username: string, password: string, code: string }   code = 6 digits
 * 200:    Session { admin: { id, username }, expires_at }, and sets the session cookie
 * Errors: 401 invalid_credentials (wrong username, password or code; one answer for all three),
 *         429 rate_limited with retry_after in seconds (5 tries per 15 minutes)
 */
export function login(input: LoginInput): Promise<Session> {
  return request<Session>('POST', '/login', { body: input })
}

/**
 * POST /api/logout
 * Body:   {}
 * 200:    {} (or 204); the session is deleted and the cookie cleared. The answer is not read.
 */
export function logout(): Promise<void> {
  return request<void>('POST', '/logout')
}

/**
 * GET /api/session
 * 200:    Session { admin: { id, username }, expires_at }
 * 401:    not_signed_in, returned here as null because "not signed in" is a normal answer
 *         when the app starts.
 */
export async function getSession(): Promise<Session | null> {
  try {
    return await request<Session>('GET', '/session')
  } catch (error) {
    if (isNotSignedIn(error)) {
      return null
    }
    throw error
  }
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

/**
 * GET /api/dashboard?today_start=<date>
 * Query:  today_start (optional) = the admin's local midnight as a UTC instant; must lie within
 *         the last 26 hours, otherwise the server uses midnight UTC
 * 200:    DashboardCounters {
 *           currency,
 *           sales: { today, last_7_days, last_30_days } each { count, amount },
 *           active_licenses: { monthly, lifetime },
 *           monthly_subscribers,
 *           trials: { active, started_30_days, converted_30_days, started_total, converted_total },
 *           failed_emails, unprocessed_webhooks, open_disputes }
 *         The sales and the last three are zero until W3 fills payments, email_log and
 *         webhook_events.
 */
export function getDashboard(params: DashboardParams = {}): Promise<DashboardCounters> {
  return request<DashboardCounters>('GET', '/dashboard', { query: { today_start: params.today_start } })
}

// ---------------------------------------------------------------------------
// Licenses
// ---------------------------------------------------------------------------

/**
 * GET /api/licenses?q=&plan=&state=&expiring=1&page=&page_size=
 * Query:  q         one search box: email (contains), key ending (the 4 characters of key_hint),
 *                   a complete key in any spelling, payer_id or paypal_subscription_id
 *                   (starts with)
 *         plan      monthly | lifetime
 *         state     active | expired | revoked   (derived, see LicenseState)
 *         expiring  1 = only active licenses whose expires_at is within 7 days
 *         page, page_size
 * 200:    Page<LicenseListItem>: the license columns plus state, seats_used, last_seen_at.
 *         Newest first (created_at, then id).
 */
export function listLicenses(params: LicenseListParams = {}): Promise<Page<LicenseListItem>> {
  return request<Page<LicenseListItem>>('GET', '/licenses', {
    query: {
      q: params.q,
      plan: params.plan,
      state: params.state,
      expiring: params.expiring,
      page: params.page,
      page_size: params.page_size,
    },
  })
}

/**
 * GET /api/licenses/:id
 * 200:    LicenseDetail { license, state, activations[], events[], events_total }
 *         activations: all of them, newest first. events: the newest 200, newest first.
 *         (payments[] is added in W3.)
 * Errors: 404 not_found
 */
export function getLicense(id: number): Promise<LicenseDetail> {
  return request<LicenseDetail>('GET', `/licenses/${id}`)
}

/**
 * POST /api/licenses                                  a manual license (source = 'manual')
 * Body:   { email: string, plan: 'monthly' | 'lifetime', period_end?: date, max_devices?: number,
 *           note?: string }
 *         period_end is required for monthly (must be in the future) and not allowed for
 *         lifetime. max_devices defaults to 1.
 * 201:    CreatedLicense { license, key }: the only answer besides reveal that carries the key
 * Errors: 400 bad_request with fields
 */
export function createLicense(input: CreateLicenseInput): Promise<CreatedLicense> {
  return request<CreatedLicense>('POST', '/licenses', { body: input })
}

/**
 * POST /api/licenses/:id/revoke
 * Body:   {}
 * 200:    LicenseDetail with status = 'revoked'. Also adds a 'revoke' event.
 * Errors: 404 not_found
 */
export function revokeLicense(id: number): Promise<LicenseDetail> {
  return request<LicenseDetail>('POST', `/licenses/${id}/revoke`)
}

/**
 * POST /api/licenses/:id/restore
 * Body:   {}
 * 200:    LicenseDetail with status = 'active'
 * Errors: 404 not_found
 */
export function restoreLicense(id: number): Promise<LicenseDetail> {
  return request<LicenseDetail>('POST', `/licenses/${id}/restore`)
}

/**
 * POST /api/licenses/:id/activations/:activation_id/free          free one seat
 * Body:   {}
 * 200:    LicenseDetail; that activation now has deactivated_at set. Also adds a 'deactivate'
 *         event. The next activation of the key is a normal one and uses no transfer.
 * Errors: 404 not_found (license, or activation not on this license)
 */
export function freeSeat(id: number, activationId: number): Promise<LicenseDetail> {
  return request<LicenseDetail>('POST', `/licenses/${id}/activations/${activationId}/free`)
}

/**
 * POST /api/licenses/:id/extend                                   monthly licenses only
 * Body:   { period_end: date }   the new paid-through date: in the future and not earlier
 *         than the current one. An absolute date, so sending it twice changes nothing.
 * 200:    LicenseDetail; the server sets period_end and derives expires_at from it
 *         (plus the renewal buffer while auto_renew is on)
 * Errors: 400 bad_request { period_end }, 404 not_found, 409 conflict (lifetime license)
 */
export function extendLicense(id: number, input: ExtendLicenseInput): Promise<LicenseDetail> {
  return request<LicenseDetail>('POST', `/licenses/${id}/extend`, { body: input })
}

/**
 * POST /api/licenses/:id/plan
 * Body:   { plan: 'lifetime' }                        period_end and expires_at become null,
 *                                                     auto_renew off
 *       | { plan: 'monthly', period_end: date }       period_end in the future, auto_renew off
 * 200:    LicenseDetail
 * Errors: 400 bad_request { plan | period_end }, 404 not_found,
 *         409 conflict (the license already has this plan)
 */
export function changeLicensePlan(id: number, input: ChangePlanInput): Promise<LicenseDetail> {
  return request<LicenseDetail>('POST', `/licenses/${id}/plan`, { body: input })
}

/**
 * POST /api/licenses/:id/max-devices                              allow more Macs
 * Body:   { max_devices: number }   whole number, at least 1 and at least the seats in use
 * 200:    LicenseDetail
 * Errors: 400 bad_request { max_devices }, 404 not_found
 */
export function setLicenseMaxDevices(id: number, input: SetMaxDevicesInput): Promise<LicenseDetail> {
  return request<LicenseDetail>('POST', `/licenses/${id}/max-devices`, { body: input })
}

/**
 * POST /api/licenses/:id/resend-key
 * Body:   {}
 * 200:    ResendKeyResult { to_email }: the key email was queued for the license's own email.
 *         (Email arrives in W3. Until then W2 can answer 200 without sending, or refuse.)
 * Errors: 404 not_found
 */
export function resendLicenseKey(id: number): Promise<ResendKeyResult> {
  return request<ResendKeyResult>('POST', `/licenses/${id}/resend-key`)
}

/**
 * POST /api/licenses/:id/reveal-key                 POST because every reveal is audited
 * Body:   {}
 * 200:    RevealedKey { key }
 * Errors: 404 not_found
 */
export function revealLicenseKey(id: number): Promise<RevealedKey> {
  return request<RevealedKey>('POST', `/licenses/${id}/reveal-key`)
}

/**
 * POST /api/licenses/:id/email
 * Body:   { email: string }
 * 200:    LicenseDetail
 * Errors: 400 bad_request { email }, 404 not_found
 */
export function changeLicenseEmail(id: number, input: ChangeEmailInput): Promise<LicenseDetail> {
  return request<LicenseDetail>('POST', `/licenses/${id}/email`, { body: input })
}

/**
 * POST /api/licenses/:id/note
 * Body:   { note: string }   replaces the note; an empty string clears it (note = null)
 * 200:    LicenseDetail
 * Errors: 400 bad_request { note }, 404 not_found
 */
export function setLicenseNote(id: number, input: SetNoteInput): Promise<LicenseDetail> {
  return request<LicenseDetail>('POST', `/licenses/${id}/note`, { body: input })
}

// ---------------------------------------------------------------------------
// Trials
// ---------------------------------------------------------------------------

/**
 * GET /api/trials?state=&page=&page_size=
 * Query:  state  active | ended   (derived from expires_at, see TrialState)
 * 200:    Page<TrialListItem>: the trial columns plus state and converted_license_id.
 *         Newest first (started_at).
 */
export function listTrials(params: TrialListParams = {}): Promise<Page<TrialListItem>> {
  return request<Page<TrialListItem>>('GET', '/trials', {
    query: { state: params.state, page: params.page, page_size: params.page_size },
  })
}

/**
 * POST /api/trials                                  start or look up a trial for a device
 * Body:   { device_id: string, app_version?: string, days?: number, reset?: boolean }
 *         device_id is 16–128 characters from A-Za-z0-9_-. days defaults to settings.trial_days.
 *         reset=true restarts an ended trial; it does not shorten an active one.
 * 200:    TrialListItem when this device already has an active trial, or after a reset
 * 201:    TrialListItem when a new trial was created
 * Errors: 400 bad_request with fields { device_id | app_version | days },
 *         409 conflict when the trial already ended and reset was not set
 *
 * Production trials normally start inside the Mac app (POST /v1/trial). This admin call is
 * for support and testing: it does not issue a license token.
 */
export function createTrial(input: CreateTrialInput): Promise<TrialListItem> {
  return request<TrialListItem>('POST', '/trials', { body: input })
}

/** Alias for createTrial: grant a trial to a device id from admin. */
export const grantTrial = createTrial

/**
 * GET /api/trial-leads?q=&page=&page_size=
 * Website email captures before download. Newest first.
 */
export function listTrialLeads(params: { q?: string; page?: number; page_size?: number } = {}): Promise<Page<TrialLead>> {
  return request<Page<TrialLead>>('GET', '/trial-leads', {
    query: { q: params.q, page: params.page, page_size: params.page_size },
  })
}

/**
 * GET /api/emails?q=&status=&page=&page_size=
 * Outbound mail log (trial download, keys, …). Newest first.
 */
export function listEmails(
  params: { q?: string; status?: string; page?: number; page_size?: number } = {},
): Promise<Page<EmailLogItem>> {
  return request<Page<EmailLogItem>>('GET', '/emails', {
    query: { q: params.q, status: params.status, page: params.page, page_size: params.page_size },
  })
}

/**
 * GET /api/seat-moves?q=&page=&page_size=
 * Unlink / transfer history for support. Newest first.
 */
export function listSeatMoves(params: { q?: string; page?: number; page_size?: number } = {}): Promise<Page<SeatMove>> {
  return request<Page<SeatMove>>('GET', '/seat-moves', {
    query: { q: params.q, page: params.page, page_size: params.page_size },
  })
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/**
 * GET /api/settings
 * 200:    Settings { prices: { monthly, lifetime }, trial_days, transfer_limit,
 *                    renewal_buffer_hours, download_url, app_version, paypal_plan_id }
 *         prices.monthly, prices.lifetime, download_url, app_version and paypal_plan_id are
 *         null while they are not set.
 */
export function getSettings(): Promise<Settings> {
  return request<Settings>('GET', '/settings')
}

/**
 * PUT /api/settings
 * Body:   SettingsUpdate = Settings without paypal_plan_id (written by the W3 PayPal setup
 *         script), with mail including write-only smtp_pass. All fields are sent every
 *         time; null clears a value that may be unset. Omit smtp_pass to keep the stored one.
 * 200:    Settings as saved (smtp_pass_set, never the clear password)
 * Errors: 400 bad_request with fields ("prices.monthly", "mail.smtp_user", ...)
 */
export function updateSettings(input: SettingsUpdate): Promise<Settings> {
  return request<Settings>('PUT', '/settings', { body: input })
}

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

/**
 * GET /api/audit-log?action=&target=&page=&page_size=
 * Query:  action  exact action name, for example license.revoke
 *         target  exact target, for example license:42
 * 200:    Page<AuditLogEntry>: the audit_log columns plus admin_username.
 *         Newest first (created_at, then id).
 */
export function listAuditLog(params: AuditLogParams = {}): Promise<Page<AuditLogEntry>> {
  return request<Page<AuditLogEntry>>('GET', '/audit-log', {
    query: { action: params.action, target: params.target, page: params.page, page_size: params.page_size },
  })
}
