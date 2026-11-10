/**
 * Types of the admin data module.
 *
 * Field names are the column names of NOTCHOS-WEB-PLAN.md section 4, unchanged (snake_case),
 * and a field is nullable exactly where its column in db/migrations/001_init.sql is.
 * Every timestamp is an ISO 8601 string in UTC with whole seconds ("2026-11-10T03:36:27Z"),
 * the one date encoding the API already uses for the app (api/README.md, "Dates").
 * Money is a decimal string ("29.99"), never a float.
 * Fields marked "derived" are computed by the server; they are not table columns.
 * Columns that must never reach the browser are simply absent here: key_hash, key_enc,
 * password_hash, totp_secret_enc, id_hash, raw_json.
 * An answer may carry more fields than its type lists (the API adds server_time to every
 * answer); the panel ignores what it does not know.
 */

/** ISO 8601 timestamp in UTC with whole seconds, for example "2026-11-10T03:36:27Z". */
export type IsoDateTime = string

/** Decimal amount as a string with two decimals, for example "29.99". */
export type Money = string

/** One page of a list. `page` starts at 1. `total` counts every row that matches the filters. */
export interface Page<T> {
  items: T[]
  total: number
  page: number
  page_size: number
}

export interface PageParams {
  /** 1-based. Default 1. */
  page?: number
  /** One of PAGE_SIZES. Default DEFAULT_PAGE_SIZE. */
  page_size?: number
}

export const PAGE_SIZES = [25, 50, 100] as const
export const DEFAULT_PAGE_SIZE = 50

// ---------------------------------------------------------------------------
// Session (admin_users, admin_sessions)
// ---------------------------------------------------------------------------

export interface AdminUser {
  id: number
  username: string
}

export interface Session {
  admin: AdminUser
  /** admin_sessions.expires_at */
  expires_at: IsoDateTime
}

export interface LoginInput {
  username: string
  password: string
  /** The 6-digit authenticator code, digits only. */
  code: string
}

// ---------------------------------------------------------------------------
// Licenses (licenses, activations, events)
// ---------------------------------------------------------------------------

export type LicensePlan = 'monthly' | 'lifetime'
export type LicenseStatus = 'active' | 'revoked'
export type LicenseSource = 'paypal' | 'manual'

/**
 * Derived. What the license is worth right now, decided by the server clock:
 *   revoked  status = 'revoked'
 *   expired  status = 'active' and expires_at is in the past
 *   active   status = 'active' and (expires_at is null or in the future)
 */
export type LicenseState = 'active' | 'expired' | 'revoked'

/** A license is "expiring soon" when it is active and expires within this many days. */
export const EXPIRING_SOON_DAYS = 7

export interface License {
  id: number
  /** Last 4 characters of the key. The key itself is only returned by reveal and by create. */
  key_hint: string
  email: string
  /** PayPal payer id. null for manual licenses. */
  payer_id: string | null
  plan: LicensePlan
  status: LicenseStatus
  max_devices: number
  /** What the buyer has paid for. null = lifetime. */
  period_end: IsoDateTime | null
  /** What the app enforces. null = lifetime. */
  expires_at: IsoDateTime | null
  /** A JSON boolean (the column is TINYINT(1)). */
  auto_renew: boolean
  paypal_subscription_id: string | null
  transfers_used: number
  source: LicenseSource
  note: string | null
  created_at: IsoDateTime
  updated_at: IsoDateTime
}

export interface LicenseListItem extends License {
  /** Derived, see LicenseState. */
  state: LicenseState
  /** Derived: activations of this license with deactivated_at = null. */
  seats_used: number
  /** Derived: the newest last_seen_at among those activations, or null if there is none. */
  last_seen_at: IsoDateTime | null
}

export interface Activation {
  id: number
  license_id: number
  /** The app's hashed device id (64 hex characters). */
  device_id: string
  /** The Mac's name as the app sent it. null if it sent none. */
  device_name: string | null
  /** null if the app sent none. */
  app_version: string | null
  activated_at: IsoDateTime
  last_seen_at: IsoDateTime
  /** null = this Mac holds a seat. */
  deactivated_at: IsoDateTime | null
}

/** The event types the API writes today (events.type is free text, so more may follow). */
export type LicenseEventType =
  | 'activate'
  | 'refresh'
  | 'deny'
  | 'transfer'
  | 'deactivate'
  | 'revoke'
  | 'renew'
  | 'trial'

export interface LicenseEvent {
  id: number
  license_id: number | null
  device_id: string | null
  /** One of LicenseEventType, or a newer type this build does not know yet. */
  type: string
  detail: string | null
  ip: string | null
  created_at: IsoDateTime
}

/** How many events a license detail answer carries at most (the newest ones). */
export const LICENSE_DETAIL_EVENT_LIMIT = 200

export interface LicenseDetail {
  license: License
  /** Derived, see LicenseState. */
  state: LicenseState
  /** Every activation of this license, newest first. */
  activations: Activation[]
  /** The newest events of this license, newest first, at most LICENSE_DETAIL_EVENT_LIMIT. */
  events: LicenseEvent[]
  /** Derived: how many events this license has in total. */
  events_total: number
  // payments: Payment[] arrives in W3.
}

export interface LicenseListParams extends PageParams {
  /**
   * One search box. Matches: email (contains), the key ending (exactly the 4 characters of
   * key_hint), a complete key, payer_id or paypal_subscription_id (starts with).
   */
  q?: string
  plan?: LicensePlan
  state?: LicenseState
  /** true = only active licenses that expire within EXPIRING_SOON_DAYS. */
  expiring?: boolean
}

export interface CreateLicenseInput {
  email: string
  plan: LicensePlan
  /** Required for monthly, not allowed for lifetime. Must be in the future. */
  period_end?: IsoDateTime
  /** Default 1. */
  max_devices?: number
  note?: string
}

export interface CreatedLicense {
  license: License
  /** The complete key, NOS-XXXXX-XXXXX-XXXXX-XXXXX. Shown once after creating. */
  key: string
}

export interface ExtendLicenseInput {
  /** The new paid-through date. Must be later than the current one and in the future. */
  period_end: IsoDateTime
}

export type ChangePlanInput =
  | { plan: 'lifetime' }
  | {
      plan: 'monthly'
      /** Paid-through date of the monthly license. Must be in the future. */
      period_end: IsoDateTime
    }

export interface SetMaxDevicesInput {
  max_devices: number
}

export interface ChangeEmailInput {
  email: string
}

export interface SetNoteInput {
  /** An empty string clears the note. */
  note: string
}

export interface ResendKeyResult {
  /** The address the key email was queued for. */
  to_email: string
}

export interface RevealedKey {
  key: string
}

// ---------------------------------------------------------------------------
// Trials (trials)
// ---------------------------------------------------------------------------

export interface Trial {
  device_id: string
  /** Optional support email from the app or a website lead. null if unknown. */
  email: string | null
  started_at: IsoDateTime
  expires_at: IsoDateTime
  /** null if the app sent none. */
  app_version: string | null
  ip: string | null
}

/** Website download-lead row (does not start a device trial). */
export interface TrialLead {
  id: number
  email: string
  status: 'new' | 'mailed' | 'bounced' | 'converted'
  download_sent_at: IsoDateTime | null
  resend_count: number
  converted_trial_device_id: string | null
  converted_license_id: number | null
  created_at: IsoDateTime
}

export type SeatMoveReason = 'user_deactivate' | 'user_transfer' | 'admin_free_seat' | 'admin_revoke'
export type SeatMoveActor = 'user' | 'admin' | 'system'

/** Support log of unlink / transfer / admin free-seat. */
export interface SeatMove {
  id: number
  license_id: number
  email: string
  key_hint: string
  from_device_id: string | null
  from_device_name: string | null
  to_device_id: string | null
  to_device_name: string | null
  reason: SeatMoveReason
  transfers_used_after: number
  transfers_left_after: number
  actor: SeatMoveActor
  detail: string | null
  created_at: IsoDateTime
}

/** Derived: 'active' while expires_at is in the future, by the server clock. */
export type TrialState = 'active' | 'ended'

export interface TrialListItem extends Trial {
  /** Derived, see TrialState. */
  state: TrialState
  /** Derived: the license this device later activated (activations.device_id), or null. */
  converted_license_id: number | null
}

export interface TrialListParams extends PageParams {
  state?: TrialState
}

/**
 * Body for POST /api/trials: grant or look up a trial by Mac device id.
 * Same shape the Mac app sends to POST /v1/trial.
 */
export interface CreateTrialInput {
  /** 16–128 characters from A–Z a–z 0–9 _ -. */
  device_id: string
  /** Optional support email; does not grant an extra trial. */
  email?: string | null
  /** Optional app version string; null/omitted when unknown. */
  app_version?: string | null
  /** Length of a new or reset trial in days (1–365). Defaults to settings.trial_days. */
  days?: number
  /** When true, an ended trial is restarted with a fresh period. Active trials are left alone. */
  reset?: boolean
}

// ---------------------------------------------------------------------------
// Dashboard (all derived)
// ---------------------------------------------------------------------------

export interface SalesWindow {
  /** Completed payments in the window (orders and subscription payments, not refunds). */
  count: number
  amount: Money
}

export interface DashboardCounters {
  /** ISO 4217 code of every amount below. */
  currency: string
  sales: {
    today: SalesWindow
    last_7_days: SalesWindow
    last_30_days: SalesWindow
  }
  /** Licenses in state 'active', by plan. */
  active_licenses: {
    monthly: number
    lifetime: number
  }
  /** Monthly licenses in state 'active' with auto_renew on. */
  monthly_subscribers: number
  trials: {
    /** Trials whose expires_at is in the future. */
    active: number
    started_30_days: number
    /** Of the trials started in the last 30 days: devices that later activated a key. */
    converted_30_days: number
    started_total: number
    converted_total: number
  }
  failed_emails: number
  unprocessed_webhooks: number
  open_disputes: number
}

export interface DashboardParams {
  /**
   * Where "today" starts: the admin's local midnight as a UTC instant. Must lie within the
   * last 26 hours; otherwise, or when absent, the server uses midnight UTC.
   */
  today_start?: IsoDateTime
}

// ---------------------------------------------------------------------------
// Settings (settings)
// ---------------------------------------------------------------------------

/** How outbound mail is delivered. */
export type MailMode = 'file' | 'smtp'

/**
 * Outbound email (Gmail SMTP or local file preview). The password itself is never returned;
 * only `smtp_pass_set` says whether one is stored.
 */
export interface MailSettings {
  mode: MailMode
  smtp_host: string
  smtp_port: number
  smtp_secure: boolean
  /** Gmail address / SMTP username. null = not set. */
  smtp_user: string | null
  /** True when a password is stored. The clear password is never sent to the browser. */
  smtp_pass_set: boolean
  /** From header, for example `NotchOS <you@gmail.com>`. null = derived from smtp_user. */
  mail_from: string | null
  /** Shown in email footers. null = default support@notchos.app. */
  support_email: string | null
}

/** What the Settings page sends for mail. `smtp_pass` is write-only. */
export interface MailSettingsUpdate {
  mode: MailMode
  smtp_host: string
  smtp_port: number
  smtp_secure: boolean
  smtp_user: string | null
  /**
   * Omit / undefined = keep the stored password.
   * null or "" = clear it.
   * A non-empty string = replace it (Gmail app password).
   */
  smtp_pass?: string | null
  mail_from: string | null
  support_email: string | null
}

/**
 * The settings table as one object. trial_days, transfer_limit and renewal_buffer_hours
 * always have a value (the migration seeds them). The others are null until someone sets
 * them: the prices are the owner's decision, the download link and version come with the
 * first release, the plan id with the PayPal setup.
 */
export interface Settings {
  prices: {
    /** null = not set yet. */
    monthly: Money | null
    /** null = not set yet. */
    lifetime: Money | null
  }
  trial_days: number
  /** Seat moves a buyer can make per license (licenses.transfers_used counts them). */
  transfer_limit: number
  /** 0 turns the renewal buffer off. */
  renewal_buffer_hours: number
  /** null = not set yet. */
  download_url: string | null
  /** null = not set yet. */
  app_version: string | null
  /** Read-only here: written by scripts/paypal-setup.ts in W3. null until then. */
  paypal_plan_id: string | null
  /** Gmail / SMTP outbound mail. */
  mail: MailSettings
}

/** Everything the Settings page can change. null clears a value that may be unset. */
export type SettingsUpdate = Omit<Settings, 'paypal_plan_id' | 'mail'> & {
  mail: MailSettingsUpdate
}

// ---------------------------------------------------------------------------
// Audit log (audit_log)
// ---------------------------------------------------------------------------

/** The actions this panel writes. The server may add more (W3: webhook replay, email resend). */
export const AUDIT_ACTIONS = [
  'login',
  'logout',
  'license.create',
  'license.revoke',
  'license.restore',
  'license.free_seat',
  'license.extend',
  'license.change_plan',
  'license.set_max_devices',
  'license.resend_key',
  'license.reveal_key',
  'license.change_email',
  'license.set_note',
  'settings.update',
] as const

export type AuditAction = (typeof AUDIT_ACTIONS)[number]

export interface AuditLogEntry {
  id: number
  /** null once the admin account has been deleted; the row stays. */
  admin_id: number | null
  /** Derived: admin_users.username of admin_id. null together with admin_id. */
  admin_username: string | null
  /** One of AUDIT_ACTIONS, or a newer action this build does not know yet. */
  action: string
  /** "license:<id>", "settings" or "session". */
  target: string | null
  detail: string | null
  ip: string | null
  created_at: IsoDateTime
}

export interface AuditLogParams extends PageParams {
  /** Exact action name. */
  action?: string
  /** Exact target, for example "license:42". */
  target?: string
}
