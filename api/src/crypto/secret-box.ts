// Encrypts small secrets that must be readable again by the server (the admin's TOTP
// secret, the SMTP password). Same scheme as LicenseKeyCipher: AES-256-GCM with
// KEY_ENC_SECRET, stored as v1.<iv>.<ciphertext>.<tag> (each part base64url), and a piece
// of additional authenticated data so a value only decrypts in the place it belongs to.

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ENC_VERSION = 'v1';
const IV_BYTES = 12;
const TAG_BYTES = 16;

export class SecretBox {
  readonly #secret: Buffer;

  constructor(secret: Buffer) {
    if (secret.length !== 32) throw new Error('the key encryption secret must be 32 bytes');
    this.#secret = secret;
  }

  encrypt(plaintext: Buffer | string, aad: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.#secret, iv, { authTagLength: TAG_BYTES });
    cipher.setAAD(Buffer.from(aad, 'utf8'));
    const data = typeof plaintext === 'string' ? Buffer.from(plaintext, 'utf8') : plaintext;
    const ciphertext = Buffer.concat([cipher.update(data), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [ENC_VERSION, iv.toString('base64url'), ciphertext.toString('base64url'), tag.toString('base64url')].join('.');
  }

  /** Throws when the value is malformed, was encrypted with another secret, or belongs elsewhere. */
  decrypt(stored: string, aad: string): Buffer {
    const [version, ivText, ciphertextText, tagText, ...rest] = stored.split('.');
    if (version !== ENC_VERSION || !ivText || !ciphertextText || !tagText || rest.length > 0) {
      throw new Error('stored secret has an unknown format');
    }
    const iv = Buffer.from(ivText, 'base64url');
    const tag = Buffer.from(tagText, 'base64url');
    if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) throw new Error('stored secret has an unknown format');
    const decipher = createDecipheriv('aes-256-gcm', this.#secret, iv, { authTagLength: TAG_BYTES });
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(tag);
    try {
      return Buffer.concat([decipher.update(Buffer.from(ciphertextText, 'base64url')), decipher.final()]);
    } catch {
      throw new Error('stored secret cannot be decrypted with this secret');
    }
  }
}

/** AAD of an admin's TOTP secret: bound to the username, so a copy in another row is useless. */
export function totpSecretAad(username: string): string {
  return `admin-totp:${username}`;
}
