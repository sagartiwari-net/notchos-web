/**
 * An in-browser stand-in for the admin API. Deleted in W2 together with the rest of
 * src/api/mock.
 *
 * It answers the same requests the real server will get: a method, a path under /api with its
 * query string, and a JSON body, and it replies with an HTTP status and a JSON body. So the
 * functions in ../endpoints.ts and the response handling in ../transport.ts already run exactly
 * as they will against the real API. Its answers follow the API's existing conventions
 * (api/README.md): every answer is a JSON object with server_time, dates are UTC with whole
 * seconds, and an error is { error, message, ... }.
 *
 * State lives in memory: actions change what later calls return and add audit rows, and a page
 * reload starts again from the seed. Only the "signed in" marker is kept in localStorage, so a
 * reload stays signed in (the real API uses an HttpOnly session cookie instead).
 */

import type { ApiErrorCode } from '../errors'
import {
  DEFAULT_PAGE_SIZE,
  EXPIRING_SOON_DAYS,
  LICENSE_DETAIL_EVENT_LIMIT,
  type Activation,
  type AuditLogEntry,
  type CreatedLicense,
  type DashboardCounters,
  type License,
  type LicenseDetail,
  type LicenseEventType,
  type LicenseListItem,
  type LicenseState,
  type Page,
  type ResendKeyResult,
  type RevealedKey,
  type SalesWindow,
  type Session,
  type MailMode,
  type MailSettings,
  type Settings,
  type Trial,
  type TrialListItem,
} from '../types'
import { readMockFlags, type MockFlags } from './flags'
import {
  buildSeed,
  DAY,
  generateKey,
  HOUR,
  MINUTE,
  MOCK_ADMIN_IP,
  toIso,
  type LicenseRow,
  type MockDb,
} from './seed'

export interface WireResponse {
  status: number
  /** JSON text, or '' when there is no body. */
  body: string
}

const SESSION_STORAGE_KEY = 'notchos-admin.mock-session'
const MAIL_STORAGE_KEY = 'notchos-admin.mock-mail'
const SESSION_HOURS = 12
const USERNAME_MAX_LENGTH = 64
const MAX_DEVICES_LIMIT = 100
/** The same limit the API's command line has for --note. */
const NOTE_MAX_LENGTH = 2000
/** Same bounds as the Mac app's device_id on /v1/trial. */
const DEVICE_ID_MIN = 16
const DEVICE_ID_MAX = 128
const DEVICE_ID_PATTERN = /^[A-Za-z0-9_-]+$/
/** Same maxLength as the app's app_version field on /v1/trial. */
const APP_VERSION_MAX = 64
/** The ranges the API accepts for these settings (api/src/services/settings.ts). */
const SETTING_RANGE = {
  trial_days: { min: 1, max: 365 },
  transfer_limit: { min: 0, max: 1000 },
  renewal_buffer_hours: { min: 0, max: 720 },
} as const

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

class HttpError extends Error {
  readonly status: number
  readonly code: ApiErrorCode
  /** Extra members of the error object, for example { fields } or { retry_after }. */
  readonly extra: Record<string, unknown>

  constructor(status: number, code: ApiErrorCode, message: string, extra: Record<string, unknown> = {}) {
    super(message)
    this.name = 'HttpError'
    this.status = status
    this.code = code
    this.extra = extra
  }
}

function invalid(fields: Record<string, string>): never {
  throw new HttpError(400, 'bad_request', Object.values(fields)[0] ?? 'The request was refused.', { fields })
}

function conflict(message: string): never {
  throw new HttpError(409, 'conflict', message)
}

function notFound(message: string): never {
  throw new HttpError(404, 'not_found', message)
}

// ---------------------------------------------------------------------------
// Session marker
// ---------------------------------------------------------------------------

interface StoredSession {
  username: string
  expires_at: string
}

/** Used only if localStorage is not available (for example blocked by the browser). */
let memorySession: StoredSession | null = null

function readStoredSession(now: number): StoredSession | null {
  let stored: StoredSession | null
  try {
    const raw = window.localStorage.getItem(SESSION_STORAGE_KEY)
    stored = raw === null ? null : parseStoredSession(JSON.parse(raw))
  } catch {
    stored = memorySession
  }
  if (stored === null || !(Date.parse(stored.expires_at) > now)) {
    return null
  }
  return stored
}

function parseStoredSession(value: unknown): StoredSession | null {
  if (typeof value !== 'object' || value === null) {
    return null
  }
  const { username, expires_at } = value as Record<string, unknown>
  if (typeof username !== 'string' || typeof expires_at !== 'string') {
    return null
  }
  return { username, expires_at }
}

function writeStoredSession(session: StoredSession | null): void {
  memorySession = session
  try {
    if (session === null) {
      window.localStorage.removeItem(SESSION_STORAGE_KEY)
    } else {
      window.localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session))
    }
  } catch {
    // Keep the in-memory copy.
  }
}

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

let database: MockDb | null = null

function defaultMail(): MailSettings {
  return {
    mode: 'file',
    smtp_host: 'smtp.gmail.com',
    smtp_port: 465,
    smtp_secure: true,
    smtp_user: null,
    smtp_pass_set: false,
    mail_from: null,
    support_email: null,
  }
}

function readStoredMail(): { mail: MailSettings; smtpPass: string | null } | null {
  try {
    const raw = window.localStorage.getItem(MAIL_STORAGE_KEY)
    if (raw === null) return null
    const parsed = JSON.parse(raw) as { mail?: MailSettings; smtpPass?: string | null }
    if (parsed.mail === undefined) return null
    return { mail: { ...defaultMail(), ...parsed.mail }, smtpPass: parsed.smtpPass ?? null }
  } catch {
    return null
  }
}

function writeStoredMail(mail: MailSettings, smtpPass: string | null): void {
  try {
    window.localStorage.setItem(MAIL_STORAGE_KEY, JSON.stringify({ mail, smtpPass }))
  } catch {
    // Ignore quota / private mode.
  }
}

function publicSettings(db: MockDb): Settings {
  return {
    ...db.settings,
    mail: {
      ...db.settings.mail,
      smtp_pass_set: db.smtpPass !== null && db.smtpPass !== '',
    },
  }
}

function getDb(now: number): MockDb {
  if (database === null) {
    database = buildSeed(now)
    const stored = readStoredSession(now)
    if (stored !== null) {
      database.admin.username = stored.username
    }
    const mailStored = readStoredMail()
    if (mailStored !== null) {
      database.settings.mail = mailStored.mail
      database.smtpPass = mailStored.smtpPass
      database.settings.mail.smtp_pass_set = mailStored.smtpPass !== null && mailStored.smtpPass !== ''
    }
  }
  return database
}

function addAudit(db: MockDb, now: number, action: string, target: string, detail: string | null): void {
  db.audit.push({
    id: db.nextId.audit++,
    admin_id: db.admin.id,
    action,
    target,
    detail,
    ip: MOCK_ADMIN_IP,
    created_at: toIso(now),
  })
}

function addEvent(
  db: MockDb,
  now: number,
  licenseId: number,
  type: LicenseEventType,
  deviceId: string | null,
  detail: string | null,
): void {
  db.events.push({
    id: db.nextId.event++,
    license_id: licenseId,
    device_id: deviceId,
    type,
    detail,
    ip: null,
    created_at: toIso(now),
  })
}

// ---------------------------------------------------------------------------
// Derived values
// ---------------------------------------------------------------------------

function stateOf(license: License, now: number): LicenseState {
  if (license.status === 'revoked') {
    return 'revoked'
  }
  if (license.expires_at !== null && Date.parse(license.expires_at) <= now) {
    return 'expired'
  }
  return 'active'
}

function publicLicense(row: LicenseRow): License {
  const { key: _key, ...license } = row
  return license
}

function seatsInUse(db: MockDb, licenseId: number): Activation[] {
  return db.activations.filter((a) => a.license_id === licenseId && a.deactivated_at === null)
}

function newestFirst<T extends { id: number }>(time: (row: T) => string): (a: T, b: T) => number {
  return (a, b) => {
    const ta = time(a)
    const tb = time(b)
    return ta < tb ? 1 : ta > tb ? -1 : b.id - a.id
  }
}

function detailOf(db: MockDb, row: LicenseRow, now: number, flags: MockFlags): LicenseDetail {
  const activations = flags.empty
    ? []
    : db.activations.filter((a) => a.license_id === row.id).sort(newestFirst((a) => a.activated_at))
  const events = flags.empty
    ? []
    : db.events.filter((e) => e.license_id === row.id).sort(newestFirst((e) => e.created_at))
  return {
    license: publicLicense(row),
    state: stateOf(row, now),
    activations,
    events: events.slice(0, LICENSE_DETAIL_EVENT_LIMIT),
    events_total: events.length,
  }
}

function dateOnly(iso: string | null): string {
  return iso === null ? 'none' : iso.slice(0, 10)
}

// ---------------------------------------------------------------------------
// Input reading
// ---------------------------------------------------------------------------

function readEmail(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }
  const email = value.trim()
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null
}

function readInt(value: unknown, min: number, max: number): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max ? value : null
}

/** A timestamp that lies in the future, as milliseconds cut to whole seconds. */
function readFuture(value: unknown, now: number): number | null {
  if (typeof value !== 'string') {
    return null
  }
  const ms = Date.parse(value)
  if (!Number.isFinite(ms)) {
    return null
  }
  const seconds = Math.floor(ms / 1000) * 1000
  return seconds > now ? seconds : null
}

function readPrice(value: unknown): string | null {
  if (typeof value !== 'string' || !/^\d{1,6}(\.\d{1,2})?$/.test(value) || Number(value) <= 0) {
    return null
  }
  return Number(value).toFixed(2)
}

function readHttpsUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 500) {
    return null
  }
  try {
    return new URL(value).protocol === 'https:' ? value : null
  } catch {
    return null
  }
}

function readVersion(value: unknown): string | null {
  return typeof value === 'string' && /^\d+\.\d+(\.\d+)?$/.test(value) ? value : null
}

function clampInt(raw: string | null, min: number, max: number, fallback: number): number {
  const value = raw === null ? Number.NaN : Number(raw)
  return Number.isInteger(value) ? Math.min(max, Math.max(min, value)) : fallback
}

function paginate<T>(rows: T[], query: URLSearchParams): Page<T> {
  const page = clampInt(query.get('page'), 1, 1_000_000, 1)
  const pageSize = clampInt(query.get('page_size'), 1, 100, DEFAULT_PAGE_SIZE)
  const start = (page - 1) * pageSize
  return { items: rows.slice(start, start + pageSize), total: rows.length, page, page_size: pageSize }
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

interface Context {
  db: MockDb
  now: number
  flags: MockFlags
  params: Record<string, string>
  query: URLSearchParams
  /** The JSON object of a POST or PUT; {} for a GET. */
  body: Record<string, unknown>
}

interface Result {
  status: number
  json: object
}

type Handler = (ctx: Context) => Result

interface Route {
  method: string
  path: string
  segments: string[]
  handler: Handler
}

const ok = (json: object): Result => ({ status: 200, json })

function findLicense({ db, params }: Context): LicenseRow {
  const id = Number(params.id)
  const row = db.licenses.find((license) => license.id === id)
  if (row === undefined) {
    notFound('There is no license with this id.')
  }
  return row
}

function touch(row: LicenseRow, now: number): void {
  row.updated_at = toIso(now)
}

// ---- session ---------------------------------------------------------------

function sessionPayload(db: MockDb, stored: StoredSession): Session {
  return { admin: { id: db.admin.id, username: db.admin.username }, expires_at: stored.expires_at }
}

const login: Handler = ({ db, now, body, flags }) => {
  if (flags.loginRateLimited) {
    throw new HttpError(429, 'rate_limited', 'Too many sign-in attempts. Try again later.', {
      retry_after: 14 * MINUTE / 1000,
    })
  }
  const username = typeof body.username === 'string' ? body.username.trim() : ''
  const password = typeof body.password === 'string' ? body.password : ''
  const code = typeof body.code === 'string' ? body.code : ''
  const accepted =
    !flags.loginError &&
    username !== '' &&
    username.length <= USERNAME_MAX_LENGTH &&
    password !== '' &&
    /^\d{6}$/.test(code)
  if (!accepted) {
    throw new HttpError(401, 'invalid_credentials', 'Wrong username, password or code.')
  }
  // The mock accepts any non-empty username and password with any 6 digits.
  // Nothing about the password is kept.
  const stored: StoredSession = { username, expires_at: toIso(now + SESSION_HOURS * HOUR) }
  writeStoredSession(stored)
  db.admin.username = username
  addAudit(db, now, 'login', 'session', null)
  return ok(sessionPayload(db, stored))
}

const logout: Handler = ({ db, now }) => {
  addAudit(db, now, 'logout', 'session', null)
  writeStoredSession(null)
  return ok({})
}

const getSession: Handler = ({ db, now }) => {
  const stored = readStoredSession(now)
  if (stored === null) {
    throw new HttpError(401, 'not_signed_in', 'Sign in to continue.')
  }
  return ok(sessionPayload(db, stored))
}

// ---- dashboard -------------------------------------------------------------

const getDashboard: Handler = ({ db, now, query, flags }) => {
  const currency = 'USD'
  if (flags.empty) {
    const none: SalesWindow = { count: 0, amount: '0.00' }
    const zero: DashboardCounters = {
      currency,
      sales: { today: none, last_7_days: none, last_30_days: none },
      active_licenses: { monthly: 0, lifetime: 0 },
      monthly_subscribers: 0,
      trials: { active: 0, started_30_days: 0, converted_30_days: 0, started_total: 0, converted_total: 0 },
      failed_emails: 0,
      unprocessed_webhooks: 0,
      open_disputes: 0,
    }
    return ok(zero)
  }

  const today = new Date(now)
  const utcMidnight = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())
  const requested = Date.parse(query.get('today_start') ?? '')
  const todayStart =
    Number.isFinite(requested) && requested <= now && requested > now - 26 * HOUR ? requested : utcMidnight

  const sales = (since: number): SalesWindow => {
    let count = 0
    let cents = 0
    for (const payment of db.payments) {
      if (payment.kind !== 'refund' && Date.parse(payment.created_at) >= since) {
        count++
        cents += Math.round(Number(payment.amount) * 100)
      }
    }
    return { count, amount: (cents / 100).toFixed(2) }
  }

  let monthly = 0
  let lifetime = 0
  let subscribers = 0
  for (const license of db.licenses) {
    if (stateOf(license, now) !== 'active') {
      continue
    }
    if (license.plan === 'monthly') {
      monthly++
      if (license.auto_renew) {
        subscribers++
      }
    } else {
      lifetime++
    }
  }

  const activatedDevices = new Set(db.activations.map((a) => a.device_id))
  const trials = { active: 0, started_30_days: 0, converted_30_days: 0, started_total: 0, converted_total: 0 }
  for (const trial of db.trials) {
    const converted = activatedDevices.has(trial.device_id)
    trials.started_total++
    if (converted) {
      trials.converted_total++
    }
    if (Date.parse(trial.started_at) >= now - 30 * DAY) {
      trials.started_30_days++
      if (converted) {
        trials.converted_30_days++
      }
    }
    if (Date.parse(trial.expires_at) > now) {
      trials.active++
    }
  }

  const counters: DashboardCounters = {
    currency,
    sales: {
      today: sales(todayStart),
      last_7_days: sales(now - 7 * DAY),
      last_30_days: sales(now - 30 * DAY),
    },
    active_licenses: { monthly, lifetime },
    monthly_subscribers: subscribers,
    trials,
    ...db.attention,
  }
  return ok(counters)
}

// ---- licenses --------------------------------------------------------------

function matchesSearch(row: LicenseRow, q: string): boolean {
  if (row.email.toLowerCase().includes(q.toLowerCase())) {
    return true
  }
  const compact = q.replace(/[\s-]/g, '').toUpperCase()
  // The real server can only match the 4 stored characters (key_hint) or a complete key (key_hash).
  if (compact.length === 4 && row.key_hint === compact) {
    return true
  }
  if (compact.length === 23 && row.key.replace(/-/g, '') === compact) {
    return true
  }
  if (compact.length >= 3) {
    if (row.payer_id !== null && row.payer_id.startsWith(compact)) {
      return true
    }
    if (row.paypal_subscription_id !== null && row.paypal_subscription_id.replace(/-/g, '').startsWith(compact)) {
      return true
    }
  }
  return false
}

const listLicenses: Handler = ({ db, now, query, flags }) => {
  const q = (query.get('q') ?? '').trim()
  const plan = query.get('plan')
  const state = query.get('state')
  const expiring = query.get('expiring') === '1'
  if (plan !== null && plan !== 'monthly' && plan !== 'lifetime') {
    invalid({ plan: 'Unknown plan filter.' })
  }
  if (state !== null && state !== 'active' && state !== 'expired' && state !== 'revoked') {
    invalid({ state: 'Unknown status filter.' })
  }

  const seats = new Map<number, { used: number; lastSeen: string | null }>()
  for (const activation of db.activations) {
    if (activation.deactivated_at !== null) {
      continue
    }
    const entry = seats.get(activation.license_id) ?? { used: 0, lastSeen: null }
    entry.used++
    if (entry.lastSeen === null || activation.last_seen_at > entry.lastSeen) {
      entry.lastSeen = activation.last_seen_at
    }
    seats.set(activation.license_id, entry)
  }

  const soon = now + EXPIRING_SOON_DAYS * DAY
  const rows: LicenseListItem[] = []
  if (!flags.empty) {
    for (const row of db.licenses) {
      const rowState = stateOf(row, now)
      if (plan !== null && row.plan !== plan) {
        continue
      }
      if (state !== null && rowState !== state) {
        continue
      }
      if (expiring && !(rowState === 'active' && row.expires_at !== null && Date.parse(row.expires_at) <= soon)) {
        continue
      }
      if (q !== '' && !matchesSearch(row, q)) {
        continue
      }
      const seat = seats.get(row.id)
      rows.push({
        ...publicLicense(row),
        state: rowState,
        seats_used: seat?.used ?? 0,
        last_seen_at: seat?.lastSeen ?? null,
      })
    }
    rows.sort(newestFirst((row) => row.created_at))
  }
  return ok(paginate(rows, query))
}

const getLicense: Handler = (ctx) => ok(detailOf(ctx.db, findLicense(ctx), ctx.now, ctx.flags))

const createLicense: Handler = ({ db, now, body }) => {
  const fields: Record<string, string> = {}

  const email = readEmail(body.email)
  if (email === null) {
    fields.email = 'Enter a valid email address.'
  }
  const plan = body.plan === 'monthly' || body.plan === 'lifetime' ? body.plan : null
  if (plan === null) {
    fields.plan = 'Choose monthly or lifetime.'
  }
  let periodEnd: number | null = null
  if (plan === 'monthly') {
    periodEnd = readFuture(body.period_end, now)
    if (periodEnd === null) {
      fields.period_end = 'Choose an end date in the future.'
    }
  } else if (plan === 'lifetime' && body.period_end !== undefined && body.period_end !== null) {
    fields.period_end = 'A lifetime license has no end date.'
  }
  const maxDevices = body.max_devices === undefined ? 1 : readInt(body.max_devices, 1, MAX_DEVICES_LIMIT)
  if (maxDevices === null) {
    fields.max_devices = `Enter a whole number from 1 to ${MAX_DEVICES_LIMIT}.`
  }
  let note: string | null = null
  if (body.note !== undefined && body.note !== null) {
    if (typeof body.note !== 'string' || body.note.length > NOTE_MAX_LENGTH) {
      fields.note = `Enter up to ${NOTE_MAX_LENGTH} characters.`
    } else {
      note = body.note.trim() === '' ? null : body.note.trim()
    }
  }
  if (email === null || plan === null || maxDevices === null || Object.keys(fields).length > 0) {
    invalid(fields)
  }

  const key = generateKey()
  const row: LicenseRow = {
    id: db.nextId.license++,
    key,
    key_hint: key.slice(-4),
    email,
    payer_id: null,
    plan,
    status: 'active',
    max_devices: maxDevices,
    period_end: periodEnd === null ? null : toIso(periodEnd),
    expires_at: periodEnd === null ? null : toIso(periodEnd),
    auto_renew: false,
    paypal_subscription_id: null,
    transfers_used: 0,
    source: 'manual',
    note,
    created_at: toIso(now),
    updated_at: toIso(now),
  }
  db.licenses.push(row)
  addAudit(db, now, 'license.create', `license:${row.id}`, `${plan}, ${email}`)
  const created: CreatedLicense = { license: publicLicense(row), key }
  return { status: 201, json: created }
}

const revokeLicense: Handler = (ctx) => {
  const { db, now, flags } = ctx
  const row = findLicense(ctx)
  if (row.status !== 'revoked') {
    row.status = 'revoked'
    touch(row, now)
    addEvent(db, now, row.id, 'revoke', null, `admin:${db.admin.username}`)
    addAudit(db, now, 'license.revoke', `license:${row.id}`, null)
  }
  return ok(detailOf(db, row, now, flags))
}

const restoreLicense: Handler = (ctx) => {
  const { db, now, flags } = ctx
  const row = findLicense(ctx)
  if (row.status !== 'active') {
    row.status = 'active'
    touch(row, now)
    addAudit(db, now, 'license.restore', `license:${row.id}`, null)
  }
  return ok(detailOf(db, row, now, flags))
}

const freeSeat: Handler = (ctx) => {
  const { db, now, flags, params } = ctx
  const row = findLicense(ctx)
  const activationId = Number(params.activation_id)
  const activation = db.activations.find((a) => a.id === activationId && a.license_id === row.id)
  if (activation === undefined) {
    notFound('This license has no such activation.')
  }
  if (activation.deactivated_at === null) {
    activation.deactivated_at = toIso(now)
    touch(row, now)
    addEvent(db, now, row.id, 'deactivate', activation.device_id, `admin:${db.admin.username}: freed the seat`)
    addAudit(db, now, 'license.free_seat', `license:${row.id}`, activation.device_name ?? 'unnamed Mac')
  }
  return ok(detailOf(db, row, now, flags))
}

const extendLicense: Handler = (ctx) => {
  const { db, now, flags, body } = ctx
  const row = findLicense(ctx)
  if (row.plan !== 'monthly') {
    conflict('A lifetime license has no end date to extend.')
  }
  const periodEnd = readFuture(body.period_end, now)
  if (periodEnd === null) {
    invalid({ period_end: 'Choose a date in the future.' })
  }
  const current = row.period_end === null ? null : Date.parse(row.period_end)
  if (current !== null && periodEnd < current) {
    invalid({ period_end: 'Choose a date later than the current paid-through date.' })
  }
  if (current !== periodEnd) {
    const before = row.period_end
    row.period_end = toIso(periodEnd)
    row.expires_at = toIso(row.auto_renew ? periodEnd + db.settings.renewal_buffer_hours * HOUR : periodEnd)
    touch(row, now)
    addEvent(db, now, row.id, 'renew', null, `admin:${db.admin.username}: paid through ${dateOnly(row.period_end)}`)
    addAudit(
      db,
      now,
      'license.extend',
      `license:${row.id}`,
      `period_end: ${dateOnly(before)} → ${dateOnly(row.period_end)}`,
    )
  }
  return ok(detailOf(db, row, now, flags))
}

const changePlan: Handler = (ctx) => {
  const { db, now, flags, body } = ctx
  const row = findLicense(ctx)
  if (body.plan === 'lifetime') {
    if (row.plan === 'lifetime') {
      conflict('This license is already lifetime.')
    }
    row.plan = 'lifetime'
    row.period_end = null
    row.expires_at = null
    row.auto_renew = false
    touch(row, now)
    addAudit(db, now, 'license.change_plan', `license:${row.id}`, 'monthly → lifetime')
  } else if (body.plan === 'monthly') {
    if (row.plan === 'monthly') {
      conflict('This license is already monthly. Use Extend to move its end date.')
    }
    const periodEnd = readFuture(body.period_end, now)
    if (periodEnd === null) {
      invalid({ period_end: 'Choose an end date in the future.' })
    }
    row.plan = 'monthly'
    row.period_end = toIso(periodEnd)
    row.expires_at = toIso(periodEnd)
    row.auto_renew = false
    touch(row, now)
    addAudit(
      db,
      now,
      'license.change_plan',
      `license:${row.id}`,
      `lifetime → monthly, paid through ${dateOnly(row.period_end)}`,
    )
  } else {
    invalid({ plan: 'Choose monthly or lifetime.' })
  }
  return ok(detailOf(db, row, now, flags))
}

const setMaxDevices: Handler = (ctx) => {
  const { db, now, flags, body } = ctx
  const row = findLicense(ctx)
  const value = readInt(body.max_devices, 1, MAX_DEVICES_LIMIT)
  if (value === null) {
    invalid({ max_devices: `Enter a whole number from 1 to ${MAX_DEVICES_LIMIT}.` })
  }
  const inUse = seatsInUse(db, row.id).length
  if (value < inUse) {
    invalid({
      max_devices: `${inUse} ${inUse === 1 ? 'Mac holds' : 'Macs hold'} a seat on this license. Free a seat first.`,
    })
  }
  if (value !== row.max_devices) {
    const before = row.max_devices
    row.max_devices = value
    touch(row, now)
    addAudit(db, now, 'license.set_max_devices', `license:${row.id}`, `${before} → ${value}`)
  }
  return ok(detailOf(db, row, now, flags))
}

const resendKey: Handler = (ctx) => {
  const { db, now } = ctx
  const row = findLicense(ctx)
  // Email arrives in W3. The mock only records that a resend was asked for.
  addAudit(db, now, 'license.resend_key', `license:${row.id}`, row.email)
  const result: ResendKeyResult = { to_email: row.email }
  return ok(result)
}

const revealKey: Handler = (ctx) => {
  const { db, now } = ctx
  const row = findLicense(ctx)
  addAudit(db, now, 'license.reveal_key', `license:${row.id}`, null)
  const result: RevealedKey = { key: row.key }
  return ok(result)
}

const changeEmail: Handler = (ctx) => {
  const { db, now, flags, body } = ctx
  const row = findLicense(ctx)
  const email = readEmail(body.email)
  if (email === null) {
    invalid({ email: 'Enter a valid email address.' })
  }
  if (email !== row.email) {
    const before = row.email
    row.email = email
    touch(row, now)
    addAudit(db, now, 'license.change_email', `license:${row.id}`, `${before} → ${email}`)
  }
  return ok(detailOf(db, row, now, flags))
}

const setNote: Handler = (ctx) => {
  const { db, now, flags, body } = ctx
  const row = findLicense(ctx)
  const raw = body.note
  if (typeof raw !== 'string' || raw.length > NOTE_MAX_LENGTH) {
    invalid({ note: `Enter up to ${NOTE_MAX_LENGTH} characters.` })
  }
  const note = raw.trim() === '' ? null : raw.trim()
  if (note !== row.note) {
    row.note = note
    touch(row, now)
    addAudit(db, now, 'license.set_note', `license:${row.id}`, note === null ? 'note cleared' : 'note updated')
  }
  return ok(detailOf(db, row, now, flags))
}

// ---- trials ----------------------------------------------------------------

/** The first license each device activated (activations.device_id → licenses.id). */
function firstLicenseByDevice(db: MockDb): Map<string, number> {
  const first = new Map<string, { licenseId: number; at: string }>()
  for (const activation of db.activations) {
    const known = first.get(activation.device_id)
    if (known === undefined || activation.activated_at < known.at) {
      first.set(activation.device_id, { licenseId: activation.license_id, at: activation.activated_at })
    }
  }
  const ids = new Map<string, number>()
  for (const [deviceId, entry] of first) {
    ids.set(deviceId, entry.licenseId)
  }
  return ids
}

function trialListItem(trial: Trial, now: number, convertedLicenseId: number | null): TrialListItem {
  return {
    ...trial,
    state: Date.parse(trial.expires_at) > now ? 'active' : 'ended',
    converted_license_id: convertedLicenseId,
  }
}

const listTrials: Handler = ({ db, now, query, flags }) => {
  const state = query.get('state')
  if (state !== null && state !== 'active' && state !== 'ended') {
    invalid({ state: 'Unknown status filter.' })
  }
  const firstLicense = firstLicenseByDevice(db)
  const rows: TrialListItem[] = []
  if (!flags.empty) {
    for (const trial of db.trials) {
      const item = trialListItem(trial, now, firstLicense.get(trial.device_id) ?? null)
      if (state !== null && item.state !== state) {
        continue
      }
      rows.push(item)
    }
    rows.sort((a, b) => (a.started_at < b.started_at ? 1 : a.started_at > b.started_at ? -1 : 0))
  }
  return ok(paginate(rows, query))
}

/**
 * Start a trial for a device, return an active one, or reset an ended one when asked.
 * Mirrors the Mac app's POST /v1/trial for the common case; admin may pass days and reset.
 */
const createTrial: Handler = ({ db, now, body }) => {
  const fields: Record<string, string> = {}

  const deviceId = typeof body.device_id === 'string' ? body.device_id.trim() : ''
  if (
    deviceId.length < DEVICE_ID_MIN ||
    deviceId.length > DEVICE_ID_MAX ||
    !DEVICE_ID_PATTERN.test(deviceId)
  ) {
    fields.device_id = `Enter ${DEVICE_ID_MIN}–${DEVICE_ID_MAX} characters from A–Z, a–z, 0–9, _ or -.`
  }

  let appVersion: string | null = null
  if (body.app_version !== undefined && body.app_version !== null && body.app_version !== '') {
    if (typeof body.app_version !== 'string' || body.app_version.trim().length > APP_VERSION_MAX) {
      fields.app_version = `Enter up to ${APP_VERSION_MAX} characters.`
    } else {
      appVersion = body.app_version.trim()
    }
  }

  const daysRange = SETTING_RANGE.trial_days
  let days = db.settings.trial_days
  if (body.days !== undefined && body.days !== null) {
    const parsed = readInt(body.days, daysRange.min, daysRange.max)
    if (parsed === null) {
      fields.days = `Enter a whole number of days from ${daysRange.min} to ${daysRange.max}.`
    } else {
      days = parsed
    }
  }

  const reset = body.reset === true

  let email: string | null = null
  if (body.email !== undefined && body.email !== null && body.email !== '') {
    if (typeof body.email !== 'string') {
      fields.email = 'Enter a valid email address.'
    } else {
      email = readEmail(body.email)
      if (email === null) {
        fields.email = 'Enter a valid email address.'
      }
    }
  }

  if (Object.keys(fields).length > 0) {
    invalid(fields)
  }

  const existing = db.trials.find((trial) => trial.device_id === deviceId)
  const firstLicense = firstLicenseByDevice(db)
  const converted = firstLicense.get(deviceId) ?? null

  if (existing !== undefined) {
    const active = Date.parse(existing.expires_at) > now
    if (active) {
      if (email !== null && existing.email === null) {
        existing.email = email
      }
      return ok(trialListItem(existing, now, converted))
    }
    if (!reset) {
      conflict('This Mac already used its trial. Tick “Reset if already used” to grant another.')
    }
    existing.started_at = toIso(now)
    existing.expires_at = toIso(now + days * DAY)
    if (appVersion !== null) {
      existing.app_version = appVersion
    }
    if (email !== null) {
      existing.email = email
    }
    addAudit(
      db,
      now,
      'trial.reset',
      `device:${deviceId}`,
      `${days} day${days === 1 ? '' : 's'}, ends ${existing.expires_at}`,
    )
    return ok(trialListItem(existing, now, converted))
  }

  const startedAt = toIso(now)
  const expiresAt = toIso(now + days * DAY)
  const trial: Trial = {
    device_id: deviceId,
    email,
    started_at: startedAt,
    expires_at: expiresAt,
    app_version: appVersion,
    ip: null,
  }
  db.trials.push(trial)
  addAudit(
    db,
    now,
    'trial.grant',
    `device:${deviceId}`,
    `${days} day${days === 1 ? '' : 's'}, ends ${expiresAt}`,
  )
  return { status: 201, json: trialListItem(trial, now, converted) }
}

// ---- settings --------------------------------------------------------------

/** What the settings table holds right after the first migration: three numbers, nothing else. */
function freshInstallSettings(db: MockDb): Settings {
  return {
    prices: { monthly: null, lifetime: null },
    trial_days: db.settings.trial_days,
    transfer_limit: db.settings.transfer_limit,
    renewal_buffer_hours: db.settings.renewal_buffer_hours,
    download_url: null,
    app_version: null,
    paypal_plan_id: null,
    mail: db.settings.mail ?? defaultMail(),
  }
}

function readMailUpdate(
  raw: unknown,
  current: MailSettings,
  currentPass: string | null,
  fields: Record<string, string>,
): { mail: MailSettings; smtpPass: string | null; changes: string[] } {
  const body =
    typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : ({} as Record<string, unknown>)
  const changes: string[] = []

  let mode: MailMode = current.mode
  if (body.mode === 'file' || body.mode === 'smtp') {
    mode = body.mode
  } else if (body.mode !== undefined) {
    fields['mail.mode'] = 'Choose file (local preview) or smtp (Gmail).'
  }

  let smtpHost = current.smtp_host
  if (typeof body.smtp_host === 'string' && body.smtp_host.trim() !== '') {
    smtpHost = body.smtp_host.trim()
  } else if (body.smtp_host !== undefined && body.smtp_host !== null) {
    fields['mail.smtp_host'] = 'Enter an SMTP host, for example smtp.gmail.com.'
  }

  let smtpPort = current.smtp_port
  if (body.smtp_port !== undefined) {
    const port = readInt(body.smtp_port, 1, 65535)
    if (port === null) {
      fields['mail.smtp_port'] = 'Enter a port from 1 to 65535 (Gmail uses 465).'
    } else {
      smtpPort = port
    }
  }

  let smtpSecure = current.smtp_secure
  if (typeof body.smtp_secure === 'boolean') {
    smtpSecure = body.smtp_secure
  }

  let smtpUser: string | null = current.smtp_user
  if (body.smtp_user === null || body.smtp_user === '') {
    smtpUser = null
  } else if (typeof body.smtp_user === 'string') {
    const email = readEmail(body.smtp_user)
    if (email === null) {
      fields['mail.smtp_user'] = 'Enter the Gmail address used to sign in to SMTP.'
    } else {
      smtpUser = email
    }
  }

  let smtpPass = currentPass
  if (Object.prototype.hasOwnProperty.call(body, 'smtp_pass')) {
    if (body.smtp_pass === null || body.smtp_pass === '') {
      smtpPass = null
    } else if (typeof body.smtp_pass === 'string') {
      if (body.smtp_pass.length < 8) {
        fields['mail.smtp_pass'] = 'Enter a Gmail app password (at least 8 characters).'
      } else {
        smtpPass = body.smtp_pass
      }
    } else {
      fields['mail.smtp_pass'] = 'Enter a Gmail app password, or leave blank to keep the current one.'
    }
  }

  let mailFrom: string | null = current.mail_from
  if (body.mail_from === null || body.mail_from === '') {
    mailFrom = null
  } else if (typeof body.mail_from === 'string') {
    const trimmed = body.mail_from.trim()
    if (trimmed.length > 200) {
      fields['mail.mail_from'] = 'Keep the From line under 200 characters.'
    } else {
      mailFrom = trimmed
    }
  }

  let supportEmail: string | null = current.support_email
  if (body.support_email === null || body.support_email === '') {
    supportEmail = null
  } else if (typeof body.support_email === 'string') {
    const email = readEmail(body.support_email)
    if (email === null) {
      fields['mail.support_email'] = 'Enter a valid support email, or leave it empty.'
    } else {
      supportEmail = email
    }
  }

  if (mode === 'smtp' && smtpUser === null) {
    fields['mail.smtp_user'] = 'SMTP mode needs a Gmail address.'
  }
  if (mode === 'smtp' && (smtpPass === null || smtpPass === '')) {
    fields['mail.smtp_pass'] = 'SMTP mode needs a Gmail app password.'
  }

  const mail: MailSettings = {
    mode,
    smtp_host: smtpHost,
    smtp_port: smtpPort,
    smtp_secure: smtpSecure,
    smtp_user: smtpUser,
    smtp_pass_set: smtpPass !== null && smtpPass !== '',
    mail_from: mailFrom,
    support_email: supportEmail,
  }

  const show = (value: string | number | boolean | null) => (value === null ? 'not set' : String(value))
  const pairs: Array<[string, string | number | boolean | null, string | number | boolean | null]> = [
    ['mail.mode', current.mode, mail.mode],
    ['mail.smtp_host', current.smtp_host, mail.smtp_host],
    ['mail.smtp_port', current.smtp_port, mail.smtp_port],
    ['mail.smtp_secure', current.smtp_secure, mail.smtp_secure],
    ['mail.smtp_user', current.smtp_user, mail.smtp_user],
    ['mail.mail_from', current.mail_from, mail.mail_from],
    ['mail.support_email', current.support_email, mail.support_email],
  ]
  for (const [name, from, to] of pairs) {
    if (from !== to) changes.push(`${name}: ${show(from)} → ${show(to)}`)
  }
  if ((currentPass ?? '') !== (smtpPass ?? '')) {
    changes.push(smtpPass ? 'mail.smtp_pass: updated' : 'mail.smtp_pass: cleared')
  }

  return { mail, smtpPass, changes }
}

const getSettings: Handler = ({ db, flags }) =>
  ok(flags.empty ? freshInstallSettings(db) : publicSettings(db))

const updateSettings: Handler = ({ db, now, body, flags }) => {
  const prices =
    typeof body.prices === 'object' && body.prices !== null ? (body.prices as Record<string, unknown>) : {}
  const fields: Record<string, string> = {}

  // A value that may be unset: null is accepted and clears it.
  const optional = <T,>(value: unknown, read: (value: unknown) => T | null, name: string, message: string) => {
    if (value === null) {
      return null
    }
    const result = read(value)
    if (result === null) {
      fields[name] = message
    }
    return result
  }
  const numeric = (name: keyof typeof SETTING_RANGE, unit: string) => {
    const { min, max } = SETTING_RANGE[name]
    const result = readInt(body[name], min, max)
    if (result === null) {
      fields[name] = `Enter a whole number of ${unit} from ${min} to ${max}.`
    }
    return result ?? min
  }

  const before = flags.empty ? freshInstallSettings(db) : publicSettings(db)
  const mailResult = readMailUpdate(body.mail, before.mail, db.smtpPass, fields)

  const nextCore = {
    prices: {
      monthly: optional(prices.monthly, readPrice, 'prices.monthly', 'Enter a price above zero, for example 4.99.'),
      lifetime: optional(prices.lifetime, readPrice, 'prices.lifetime', 'Enter a price above zero, for example 29.99.'),
    },
    trial_days: numeric('trial_days', 'days'),
    transfer_limit: numeric('transfer_limit', 'moves'),
    renewal_buffer_hours: numeric('renewal_buffer_hours', 'hours'),
    download_url: optional(body.download_url, readHttpsUrl, 'download_url', 'Enter a link that starts with https://'),
    app_version: optional(body.app_version, readVersion, 'app_version', 'Enter a version such as 0.7.0.'),
  }
  if (Object.keys(fields).length > 0) {
    invalid(fields)
  }

  const pairs: Array<[string, string | number | null, string | number | null]> = [
    ['prices.monthly', before.prices.monthly, nextCore.prices.monthly],
    ['prices.lifetime', before.prices.lifetime, nextCore.prices.lifetime],
    ['trial_days', before.trial_days, nextCore.trial_days],
    ['transfer_limit', before.transfer_limit, nextCore.transfer_limit],
    ['renewal_buffer_hours', before.renewal_buffer_hours, nextCore.renewal_buffer_hours],
    ['download_url', before.download_url, nextCore.download_url],
    ['app_version', before.app_version, nextCore.app_version],
  ]
  const show = (value: string | number | null) => (value === null ? 'not set' : String(value))
  const changes = [
    ...pairs.filter(([, from, to]) => from !== to).map(([name, from, to]) => `${name}: ${show(from)} → ${show(to)}`),
    ...mailResult.changes,
  ]
  const saved: Settings = {
    ...before,
    ...nextCore,
    mail: mailResult.mail,
  }
  if (changes.length > 0) {
    db.settings = saved
    db.smtpPass = mailResult.smtpPass
    writeStoredMail(mailResult.mail, mailResult.smtpPass)
    addAudit(db, now, 'settings.update', 'settings', changes.join('; '))
  }
  return ok(publicSettings(db))
}

// ---- audit log -------------------------------------------------------------

const listAuditLog: Handler = ({ db, query, flags }) => {
  const action = query.get('action')
  const target = query.get('target')
  const rows: AuditLogEntry[] = []
  if (!flags.empty) {
    for (const row of db.audit) {
      if (action !== null && row.action !== action) {
        continue
      }
      if (target !== null && row.target !== target) {
        continue
      }
      rows.push({ ...row, admin_username: db.admin.username })
    }
    rows.sort(newestFirst((row) => row.created_at))
  }
  return ok(paginate(rows, query))
}

const listTrialLeads: Handler = ({ db, query }) => {
  const raw = query.get('q')
  const q = raw === null ? '' : raw.trim().toLowerCase()
  let rows = [...db.trialLeads].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
  if (q !== '') {
    rows = rows.filter((row) => row.email.toLowerCase().includes(q))
  }
  return ok(paginate(rows, query))
}

const listSeatMoves: Handler = ({ db, query }) => {
  const raw = query.get('q')
  const q = raw === null ? '' : raw.trim().toLowerCase()
  let rows = [...db.seatMoves].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
  if (q !== '') {
    rows = rows.filter(
      (row) =>
        row.email.toLowerCase().includes(q) ||
        row.key_hint.toLowerCase() === q ||
        (row.from_device_id?.toLowerCase().includes(q) ?? false) ||
        (row.to_device_id?.toLowerCase().includes(q) ?? false) ||
        String(row.license_id) === q,
    )
  }
  return ok(paginate(rows, query))
}

// ---- route table -----------------------------------------------------------

function route(method: string, path: string, handler: Handler): Route {
  return { method, path, segments: path.split('/').filter(Boolean), handler }
}

const LOGIN_PATH = '/login'
const LOGOUT_PATH = '/logout'
const SESSION_PATH = '/session'

const routes: Route[] = [
  route('POST', LOGIN_PATH, login),
  route('POST', LOGOUT_PATH, logout),
  route('GET', SESSION_PATH, getSession),
  route('GET', '/dashboard', getDashboard),
  route('GET', '/licenses', listLicenses),
  route('POST', '/licenses', createLicense),
  route('GET', '/licenses/:id', getLicense),
  route('POST', '/licenses/:id/revoke', revokeLicense),
  route('POST', '/licenses/:id/restore', restoreLicense),
  route('POST', '/licenses/:id/activations/:activation_id/free', freeSeat),
  route('POST', '/licenses/:id/extend', extendLicense),
  route('POST', '/licenses/:id/plan', changePlan),
  route('POST', '/licenses/:id/max-devices', setMaxDevices),
  route('POST', '/licenses/:id/resend-key', resendKey),
  route('POST', '/licenses/:id/reveal-key', revealKey),
  route('POST', '/licenses/:id/email', changeEmail),
  route('POST', '/licenses/:id/note', setNote),
  route('GET', '/trials', listTrials),
  route('POST', '/trials', createTrial),
  route('GET', '/trial-leads', listTrialLeads),
  route('GET', '/seat-moves', listSeatMoves),
  route('GET', '/settings', getSettings),
  route('PUT', '/settings', updateSettings),
  route('GET', '/audit-log', listAuditLog),
]

function matchRoute(method: string, pathname: string): { route: Route; params: Record<string, string> } | null {
  const segments = pathname.split('/').filter(Boolean)
  for (const candidate of routes) {
    if (candidate.method !== method || candidate.segments.length !== segments.length) {
      continue
    }
    const params: Record<string, string> = {}
    let matched = true
    for (let i = 0; i < segments.length; i++) {
      const pattern = candidate.segments[i]
      if (pattern.startsWith(':')) {
        params[pattern.slice(1)] = decodeURIComponent(segments[i])
      } else if (pattern !== segments[i]) {
        matched = false
        break
      }
    }
    if (matched) {
      return { route: candidate, params }
    }
  }
  return null
}

function latency(method: string, pathname: string, flags: MockFlags): number {
  if (flags.slow) {
    return 2500
  }
  if (pathname === SESSION_PATH) {
    return 60 + Math.random() * 60
  }
  return method === 'GET' ? 120 + Math.random() * 200 : 280 + Math.random() * 320
}

/** A POST or PUT must carry a JSON object, as the API requires of the app's requests. */
function readBody(method: string, body: string | undefined): Record<string, unknown> {
  if (method === 'GET') {
    return {}
  }
  let parsed: unknown
  try {
    parsed = body === undefined ? undefined : JSON.parse(body)
  } catch {
    parsed = undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new HttpError(400, 'bad_request', 'The request body must be a JSON object.')
  }
  return parsed as Record<string, unknown>
}

function respond(
  now: number,
  method: string,
  pathname: string,
  query: URLSearchParams,
  body: string | undefined,
  flags: MockFlags,
): Result {
  const match = matchRoute(method, pathname)
  if (match === null) {
    notFound(`The mock API has no route for ${method} ${pathname}.`)
  }
  const { path } = match.route
  const db = getDb(now)

  if (path !== LOGIN_PATH && readStoredSession(now) === null) {
    throw new HttpError(401, 'not_signed_in', 'Sign in to continue.')
  }
  const isSessionRoute = path === LOGIN_PATH || path === LOGOUT_PATH || path === SESSION_PATH
  if (!isSessionRoute && method === 'GET' && flags.error) {
    throw new HttpError(500, 'server_error', 'The server could not answer (forced by ?mock=error).')
  }
  if (!isSessionRoute && method !== 'GET' && flags.writeError) {
    throw new HttpError(500, 'server_error', 'The server could not save this (forced by ?mock=write-error).')
  }
  return match.route.handler({
    db,
    now,
    flags,
    params: match.params,
    query,
    body: readBody(method, body),
  })
}

export const mockServer = {
  /** `url` is the path under /api with its query string, for example "/licenses?page=2". */
  async handle(method: string, url: string, body: string | undefined): Promise<WireResponse> {
    const flags = readMockFlags()
    const queryStart = url.indexOf('?')
    const pathname = queryStart === -1 ? url : url.slice(0, queryStart)
    const query = new URLSearchParams(queryStart === -1 ? '' : url.slice(queryStart + 1))
    await new Promise((resolve) => window.setTimeout(resolve, latency(method, pathname, flags)))
    if (flags.offline) {
      // What fetch() does when the server cannot be reached.
      throw new TypeError('Failed to fetch')
    }
    const now = Date.now()
    // Every answer carries the server's clock, as the real API's answers do.
    const serverTime = { server_time: toIso(now) }
    try {
      const result = respond(now, method, pathname, query, body, flags)
      return { status: result.status, body: JSON.stringify({ ...result.json, ...serverTime }) }
    } catch (error) {
      if (error instanceof HttpError) {
        const payload = { error: error.code, message: error.message, ...error.extra, ...serverTime }
        return { status: error.status, body: JSON.stringify(payload) }
      }
      // A bug in the mock itself: make it loud instead of looking like a network failure.
      console.error('Mock API bug', error)
      const payload = { error: 'server_error', message: 'The mock API hit a bug. See the console.', ...serverTime }
      return { status: 500, body: JSON.stringify(payload) }
    }
  },
}
