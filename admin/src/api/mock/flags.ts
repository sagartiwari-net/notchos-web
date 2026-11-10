/**
 * Mock-only switches, read from the page URL on every call so each state can be opened,
 * looked at and screenshotted:
 *
 *   ?mock=empty               a fresh install: lists are empty, the dashboard counts are zero,
 *                             and the settings that have no default are not set
 *   ?mock=error               every read fails with a 500 (pages show their error state)
 *   ?mock=slow                every call takes 2.5 s (loading states)
 *   ?mock=write-error         every write fails with a 500 (actions show an error)
 *   ?mock=login-error         sign-in is refused with invalid_credentials
 *   ?mock=login-rate-limited  sign-in is refused with rate_limited and retry_after
 *   ?mock=offline             no call gets an answer at all (network_error)
 *
 * Several can be combined with commas: ?mock=slow,error
 */

export interface MockFlags {
  empty: boolean
  error: boolean
  slow: boolean
  writeError: boolean
  loginError: boolean
  loginRateLimited: boolean
  offline: boolean
}

export function readMockFlags(): MockFlags {
  const raw = new URLSearchParams(window.location.search).get('mock') ?? ''
  const set = new Set(
    raw
      .split(',')
      .map((part) => part.trim().toLowerCase())
      .filter(Boolean),
  )
  return {
    empty: set.has('empty'),
    error: set.has('error'),
    slow: set.has('slow'),
    writeError: set.has('write-error'),
    loginError: set.has('login-error'),
    loginRateLimited: set.has('login-rate-limited'),
    offline: set.has('offline'),
  }
}
