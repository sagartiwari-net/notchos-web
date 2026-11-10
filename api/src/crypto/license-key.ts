// License keys: generate, normalise, hash, encrypt.
//
// A key looks like NOS-7K2QF-M9XPA-4HRTD-W8ZC3: the prefix and 20 random characters from
// a 32-letter alphabet without 0, O, 1 and I, which is exactly 100 bits. The key carries
// no data; plan and dates live in the database and in the signed token.
//
// The database never holds a key in clear text:
//   key_hash  SHA-256 of the canonical key, used to look a key up
//   key_enc   AES-256-GCM copy, so the server can send the key again (KEY_ENC_SECRET)
//   key_hint  the last 4 characters, for support

import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const KEY_PREFIX = 'NOS';
/** 32 symbols, so one random byte maps to one symbol without bias (256 = 8 x 32). */
export const KEY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const KEY_RANDOM_LENGTH = 20;
const GROUP_LENGTH = 5;

/** The key without separators, in either case. ASCII letters only: no Unicode case mapping. */
const COMPACT_KEY = new RegExp(`^${KEY_PREFIX}([A-HJ-NP-Z2-9]{${KEY_RANDOM_LENGTH}})$`, 'i');
/** Whitespace, the ASCII hyphen and the dash characters a mail client may substitute for it. */
const SEPARATORS = /[\s\-\u2010-\u2015\u2212]/g;

function formatKey(random: string): string {
  const groups: string[] = [];
  for (let i = 0; i < random.length; i += GROUP_LENGTH) groups.push(random.slice(i, i + GROUP_LENGTH));
  return `${KEY_PREFIX}-${groups.join('-')}`;
}

/** A new random key in canonical form. */
export function generateLicenseKey(): string {
  let random = '';
  for (const byte of randomBytes(KEY_RANDOM_LENGTH)) random += KEY_ALPHABET[byte & 31];
  return formatKey(random);
}

/**
 * The canonical form (upper case, with dashes) of whatever the user pasted, or null when
 * the text cannot be a NotchOS key. Case, spaces and dashes do not matter.
 */
export function normalizeLicenseKey(input: string): string | null {
  // A real key is 27 characters. Anything far longer is not one; do not scan it.
  if (input.length > 256) return null;
  const match = COMPACT_KEY.exec(input.replace(SEPARATORS, ''));
  // The match is pure ASCII, so toUpperCase() cannot turn another letter into a valid one.
  return match ? formatKey(match[1]!.toUpperCase()) : null;
}

/** SHA-256 (hex) of a canonical key: the value stored in licenses.key_hash. */
export function hashLicenseKey(canonicalKey: string): string {
  return createHash('sha256').update(canonicalKey, 'utf8').digest('hex');
}

/** The last 4 characters, stored in licenses.key_hint. */
export function licenseKeyHint(canonicalKey: string): string {
  return canonicalKey.slice(-4);
}

/** Compare two secrets of equal length without leaking where they differ. */
export function safeEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

const ENC_VERSION = 'v1';
const IV_BYTES = 12;
const TAG_BYTES = 16;

/**
 * Encrypts and decrypts the stored copy of a key.
 * Format: v1.<iv>.<ciphertext>.<tag>, each part base64url. The key's hash is bound in as
 * additional data, so a ciphertext only decrypts in the row it belongs to.
 */
export class LicenseKeyCipher {
  readonly #secret: Buffer;

  constructor(secret: Buffer) {
    if (secret.length !== 32) throw new Error('the key encryption secret must be 32 bytes');
    this.#secret = secret;
  }

  encrypt(canonicalKey: string, keyHash: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.#secret, iv, { authTagLength: TAG_BYTES });
    cipher.setAAD(Buffer.from(keyHash, 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(canonicalKey, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [ENC_VERSION, iv.toString('base64url'), ciphertext.toString('base64url'), tag.toString('base64url')].join('.');
  }

  /** Throws when the value is malformed, was encrypted with another secret, or belongs to another row. */
  decrypt(stored: string, keyHash: string): string {
    const [version, ivText, ciphertextText, tagText, ...rest] = stored.split('.');
    if (version !== ENC_VERSION || !ivText || !ciphertextText || !tagText || rest.length > 0) {
      throw new Error('stored key copy has an unknown format');
    }
    const iv = Buffer.from(ivText, 'base64url');
    const tag = Buffer.from(tagText, 'base64url');
    if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
      throw new Error('stored key copy has an unknown format');
    }
    const decipher = createDecipheriv('aes-256-gcm', this.#secret, iv, { authTagLength: TAG_BYTES });
    decipher.setAAD(Buffer.from(keyHash, 'utf8'));
    decipher.setAuthTag(tag);
    let key: string;
    try {
      key = Buffer.concat([decipher.update(Buffer.from(ciphertextText, 'base64url')), decipher.final()]).toString('utf8');
    } catch {
      throw new Error('stored key copy cannot be decrypted with this secret');
    }
    if (!safeEqual(Buffer.from(hashLicenseKey(key), 'hex'), Buffer.from(keyHash, 'hex'))) {
      throw new Error('stored key copy does not match its hash');
    }
    return key;
  }
}
