/**
 * Formatting for the admin tables. The API speaks UTC ISO strings; the admin shows the
 * browser's local time and keeps the UTC value one hover away (see components/timestamp.tsx).
 */

const DATE_TIME = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
})

const DATE = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric' })

const RELATIVE = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })

const COUNT = new Intl.NumberFormat()

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** Local date and time, for example "10 Nov 2026, 08:22". */
export function formatDateTime(iso: string): string {
  const ms = Date.parse(iso)
  return Number.isNaN(ms) ? iso : DATE_TIME.format(ms)
}

/** Local date, for example "10 Nov 2026". */
export function formatDate(iso: string): string {
  const ms = Date.parse(iso)
  return Number.isNaN(ms) ? iso : DATE.format(ms)
}

/** The stored UTC value, for example "2026-11-10 02:52:11 UTC". */
export function formatUtc(iso: string): string {
  const ms = Date.parse(iso)
  if (Number.isNaN(ms)) {
    return iso
  }
  return `${new Date(ms).toISOString().slice(0, 19).replace('T', ' ')} UTC`
}

/** "in 3 days", "5 hours ago", "yesterday". */
export function formatRelative(iso: string, now: number = Date.now()): string {
  const ms = Date.parse(iso)
  if (Number.isNaN(ms)) {
    return ''
  }
  const diff = ms - now
  const abs = Math.abs(diff)
  if (abs < MINUTE) {
    return diff < 0 ? 'just now' : 'in under a minute'
  }
  if (abs < HOUR) {
    return RELATIVE.format(Math.round(diff / MINUTE), 'minute')
  }
  if (abs < 2 * DAY) {
    return RELATIVE.format(Math.round(diff / HOUR), 'hour')
  }
  if (abs < 60 * DAY) {
    return RELATIVE.format(Math.round(diff / DAY), 'day')
  }
  if (abs < 730 * DAY) {
    return RELATIVE.format(Math.round(diff / (30.44 * DAY)), 'month')
  }
  return RELATIVE.format(Math.round(diff / (365.25 * DAY)), 'year')
}

/** The browser's offset from UTC right now, for example "GMT+5:30". */
export function localUtcOffset(): string {
  const parts = new Intl.DateTimeFormat('en', { timeZoneName: 'shortOffset' }).formatToParts(new Date())
  return parts.find((part) => part.type === 'timeZoneName')?.value ?? 'local time'
}

/**
 * A decimal string from the API as money, for example "29.99" + "USD" -> "$29.99".
 * The short symbol is used; the page says which currency it is.
 */
export function formatMoney(amount: string, currency: string): string {
  const value = Number(amount)
  if (!Number.isFinite(value)) {
    return `${amount} ${currency}`
  }
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency, currencyDisplay: 'narrowSymbol' }).format(
      value,
    )
  } catch {
    return `${value.toFixed(2)} ${currency}`
  }
}

export function formatCount(value: number): string {
  return COUNT.format(value)
}

/** "27%" for 21 of 78; an en dash when there is nothing to divide by. */
export function formatShare(part: number, whole: number): string {
  if (whole <= 0) {
    return '–'
  }
  return `${Math.round((part / whole) * 100)}%`
}

/** The start of a long id: enough to recognise it, the full value stays in a tooltip. */
export function shortId(id: string, length = 12): string {
  return id.length <= length ? id : `${id.slice(0, length)}…`
}

/** The key with everything but its last 4 characters hidden, in the real key's layout. */
export function maskedKey(keyHint: string): string {
  return `NOS-•••••-•••••-•••••-•${keyHint}`
}

/**
 * A moment in the API's date encoding: UTC, whole seconds, "2026-11-10T03:36:27Z".
 * Every date the panel sends goes through this.
 */
export function toWireTime(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 19)}Z`
}

/** The admin's local midnight as a UTC instant, for the dashboard's "today". */
export function localMidnightIso(now: Date = new Date()): string {
  return toWireTime(new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime())
}

/** `days` after `fromMs`. */
export function addDaysIso(fromMs: number, days: number): string {
  return toWireTime(fromMs + days * DAY)
}

/** `days` from this moment. For event handlers, at the moment of sending. */
export function daysFromNowIso(days: number): string {
  return addDaysIso(Date.now(), days)
}
