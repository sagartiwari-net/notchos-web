// TOTP (RFC 6238) with the parameters every authenticator app supports:
// HMAC-SHA1, 30-second steps, 6 digits. Secrets are 160 random bits, shown as base32.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;
const SECRET_BYTES = 20;
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function generateTotpSecret(): Buffer {
  return randomBytes(SECRET_BYTES);
}

/** RFC 4648 base32 without padding (what authenticator apps expect). */
export function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

/** Inverse of base32Encode. Case, spaces and "=" padding are ignored; other characters throw. */
export function base32Decode(text: string): Buffer {
  const clean = text.replace(/[\s=]/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const index = BASE32.indexOf(ch);
    if (index === -1) throw new Error('not a base32 string');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
    value &= (1 << bits) - 1;
  }
  return Buffer.from(out);
}

/** The 6-digit code for one time step (RFC 4226 dynamic truncation). */
function codeForCounter(secret: Buffer, counter: number): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac('sha1', secret).update(message).digest();
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const binary =
    ((hmac[offset]! & 0x7f) << 24) | (hmac[offset + 1]! << 16) | (hmac[offset + 2]! << 8) | hmac[offset + 3]!;
  return String(binary % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, '0');
}

/** The code an authenticator shows at `at`. */
export function generateTotp(secret: Buffer, at: Date): string {
  return codeForCounter(secret, Math.floor(at.getTime() / 1000 / TOTP_STEP_SECONDS));
}

/** True when `code` is the code for the current step or the one before or after it (clock drift). */
export function verifyTotp(secret: Buffer, code: string, at: Date, window = 1): boolean {
  if (!/^\d{6}$/.test(code)) return false;
  const counter = Math.floor(at.getTime() / 1000 / TOTP_STEP_SECONDS);
  const given = Buffer.from(code, 'ascii');
  let match = false;
  // Every step is compared, whatever the outcome, so timing does not say which step matched.
  for (let offset = -window; offset <= window; offset++) {
    const candidate = Buffer.from(codeForCounter(secret, counter + offset), 'ascii');
    if (timingSafeEqual(candidate, given)) match = true;
  }
  return match;
}

/** The otpauth:// URL an authenticator app imports (usually as a QR code). */
export function otpauthUrl(options: { issuer: string; account: string; secret: Buffer }): string {
  const label = `${encodeURIComponent(options.issuer)}:${encodeURIComponent(options.account)}`;
  const query = new URLSearchParams({
    secret: base32Encode(options.secret),
    issuer: options.issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${query.toString()}`;
}
