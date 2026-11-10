// Admin passwords: scrypt (node:crypto), salted, in one self-describing string.
//
//   scrypt$<N>$<r>$<p>$<salt base64url>$<hash base64url>
//
// The parameters are stored with the hash, so they can be raised later without breaking
// existing accounts. Both functions are asynchronous: scrypt runs on the thread pool and
// does not block the event loop.

import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

const SCRYPT_N = 2 ** 15;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_BYTES = 64;
const SALT_BYTES = 16;
/** 128 * N * r = 32 MiB for the defaults, which is exactly Node's default limit: allow headroom. */
const MAX_MEMORY_BYTES = 128 * 1024 * 1024;
/** A stored hash asking for more than this is treated as damaged instead of being computed. */
const MAX_STORED_N = 2 ** 18;

function derive(password: string, salt: Buffer, n: number, r: number, p: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      password.normalize('NFKC'),
      salt,
      KEY_BYTES,
      { N: n, r, p, maxmem: MAX_MEMORY_BYTES },
      (err, key) => (err === null ? resolve(key) : reject(err)),
    );
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const hash = await derive(password, salt, SCRYPT_N, SCRYPT_R, SCRYPT_P);
  return ['scrypt', SCRYPT_N, SCRYPT_R, SCRYPT_P, salt.toString('base64url'), hash.toString('base64url')].join('$');
}

/** True when `password` is the one `stored` was made from. A malformed `stored` is simply false. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (![n, r, p].every((value) => Number.isInteger(value) && value > 0) || n > MAX_STORED_N || (n & (n - 1)) !== 0) {
    return false;
  }
  const salt = Buffer.from(parts[4]!, 'base64url');
  const expected = Buffer.from(parts[5]!, 'base64url');
  if (salt.length === 0 || expected.length === 0) return false;
  let actual: Buffer;
  try {
    actual = await derive(password, salt, n, r, p);
  } catch {
    return false;
  }
  // derive() always returns KEY_BYTES; a stored hash of another length cannot match.
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** A hash nobody knows the password of: verifying against it costs the same as a real account. */
export const DUMMY_PASSWORD_HASH =
  'scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA$' + Buffer.alloc(KEY_BYTES).toString('base64url');
