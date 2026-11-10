/**
 * Checks the forms run before sending, so an obvious slip is caught without a round trip.
 * They are a convenience only and are kept loose on purpose: the server validates every
 * request body itself, its limits are the real ones, and what it refuses is shown on the
 * same field.
 */

/** The same span the API's command line accepts for --days. */
export const MAX_DAYS = 3660
/** A sanity bound for typing mistakes. The server decides the real limit. */
export const MAX_DEVICES = 1000
/** The same length the API's command line accepts for --note. */
export const NOTE_MAX_LENGTH = 2000
/** Same bounds as the Mac app's device_id on /v1/trial. */
export const DEVICE_ID_MIN = 16
export const DEVICE_ID_MAX = 128
/** Optional app_version on create trial; matches the API body's maxLength. */
export const APP_VERSION_MAX = 64

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const DEVICE_ID_PATTERN = /^[A-Za-z0-9_-]+$/

export function isEmail(text: string): boolean {
  return EMAIL_PATTERN.test(text.trim())
}

/** Message for a device id, or undefined when it is fine. */
export function deviceIdProblem(text: string): string | undefined {
  const trimmed = text.trim()
  if (trimmed.length < DEVICE_ID_MIN || trimmed.length > DEVICE_ID_MAX || !DEVICE_ID_PATTERN.test(trimmed)) {
    return `Enter ${DEVICE_ID_MIN}–${DEVICE_ID_MAX} characters from A–Z, a–z, 0–9, _ or -.`
  }
  return undefined
}

/** "30" -> 30. Anything that is not a plain whole number -> null. */
export function wholeNumber(text: string): number | null {
  const trimmed = text.trim()
  return /^\d{1,6}$/.test(trimmed) ? Number(trimmed) : null
}

/** The message for a number of days, or undefined when it is fine. */
export function daysProblem(days: number | null): string | undefined {
  return days === null || days < 1 || days > MAX_DAYS ? `Enter a whole number of days from 1 to ${MAX_DAYS}.` : undefined
}

/** The message for a number of Macs, or undefined when it is fine. */
export function devicesProblem(devices: number | null): string | undefined {
  return devices === null || devices < 1 || devices > MAX_DEVICES ? 'Enter a whole number, 1 or more.' : undefined
}
