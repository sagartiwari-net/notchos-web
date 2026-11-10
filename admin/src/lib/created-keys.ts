/**
 * Hands the key of a license that was just created to its detail page, once.
 *
 * Creating a license is one of the two answers that carry a complete key. The New license
 * page puts it here and the detail page takes it out when it opens, so the key is on screen
 * right after creating without travelling through the URL or the browser history.
 * It is kept in memory only and is gone after a reload.
 */

const createdKeys = new Map<number, string>()

export function rememberCreatedKey(licenseId: number, key: string): void {
  createdKeys.set(licenseId, key)
}

/** Reads without removing, so it is safe to call while rendering. */
export function peekCreatedKey(licenseId: number): string | null {
  return createdKeys.get(licenseId) ?? null
}

export function forgetCreatedKey(licenseId: number): void {
  createdKeys.delete(licenseId)
}

/** For signing out: a key that was never shown is not kept for the next session. */
export function forgetAllCreatedKeys(): void {
  createdKeys.clear()
}
