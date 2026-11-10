// Activation tokens: Ed25519 signatures made with Node's crypto.
//
//   token = base64url(payload) + "." + base64url(signature)
//
// payload    the UTF-8 bytes of one JSON object (TokenPayload)
// signature  Ed25519 over exactly those payload bytes (64 bytes)
// base64url  RFC 4648 section 5, without "=" padding
//
// A verifier decodes the first part, checks the signature over the decoded bytes as they
// are, and only then parses them as JSON. It never re-serialises the JSON before checking.
//
// kid names the signing key: the first 16 hex characters of SHA-256 over the raw 32-byte
// public key. The app carries a list of public keys and picks the one named by kid, so a
// key can be replaced in an app update. The private key never leaves the server.

import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { assertPrivateFile, ConfigError } from '../config.ts';

export type TokenPlan = 'monthly' | 'lifetime' | 'trial';

/** The signed content of a token. Dates use the wire encoding of lib/time.ts. */
export interface TokenPayload {
  /** Which signing key made the signature. */
  kid: string;
  /** licenses.id, or null for a trial (a trial has no license). */
  license_id: number | null;
  /** The device this token is bound to, exactly as the app sent it. */
  device_id: string;
  plan: TokenPlan;
  /** The server's clock when this token was signed. */
  issued_at: string;
  /** When Pro ends; null for lifetime. */
  expires_at: string | null;
  /** The app must refresh online by this time; the token is not valid after it. */
  refresh_by: string;
}

export type TokenClaims = Omit<TokenPayload, 'kid'>;

export interface TokenSigner {
  readonly kid: string;
  /** The raw 32-byte public key in standard base64: the value the app embeds. */
  readonly publicKeyBase64: string;
  /** Sign the claims and return the token string. */
  issue(claims: TokenClaims): string;
}

export function kidForPublicKey(rawPublicKey: Buffer): string {
  return createHash('sha256').update(rawPublicKey).digest('hex').slice(0, 16);
}

function rawPublicKeyOf(privateKey: KeyObject): Buffer {
  const jwk = createPublicKey(privateKey).export({ format: 'jwk' });
  if (typeof jwk.x !== 'string') throw new Error('cannot read the Ed25519 public key');
  return Buffer.from(jwk.x, 'base64url');
}

export function createSigner(privateKey: KeyObject): TokenSigner {
  if (privateKey.type !== 'private' || privateKey.asymmetricKeyType !== 'ed25519') {
    throw new Error('the signing key must be an Ed25519 private key');
  }
  const rawPublicKey = rawPublicKeyOf(privateKey);
  const kid = kidForPublicKey(rawPublicKey);

  return {
    kid,
    publicKeyBase64: rawPublicKey.toString('base64'),
    issue(claims: TokenClaims): string {
      const payload: TokenPayload = {
        kid,
        license_id: claims.license_id,
        device_id: claims.device_id,
        plan: claims.plan,
        issued_at: claims.issued_at,
        expires_at: claims.expires_at,
        refresh_by: claims.refresh_by,
      };
      const payloadBytes = Buffer.from(JSON.stringify(payload), 'utf8');
      const signature = sign(null, payloadBytes, privateKey);
      return `${payloadBytes.toString('base64url')}.${signature.toString('base64url')}`;
    },
  };
}

/** Load the signing key from a PKCS#8 PEM file that only its owner can read. */
export function loadSigner(path: string): TokenSigner {
  assertPrivateFile(path, 'Signing key file (SIGNING_KEY_FILE)');
  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey(readFileSync(path));
  } catch {
    // The underlying error could quote the file; say only what is wrong.
    throw new ConfigError(`cannot read a private key from ${path} (SIGNING_KEY_FILE)`);
  }
  if (privateKey.asymmetricKeyType !== 'ed25519') {
    throw new ConfigError(`the key in ${path} (SIGNING_KEY_FILE) is not an Ed25519 key`);
  }
  return createSigner(privateKey);
}

export type TokenCheck = { valid: true; payload: TokenPayload } | { valid: false; reason: string };

function decodeBase64url(text: string): Buffer | null {
  if (text === '' || !/^[A-Za-z0-9_-]+$/.test(text)) return null;
  const bytes = Buffer.from(text, 'base64url');
  // Reject encodings with stray bits, so every token has exactly one spelling.
  return bytes.toString('base64url') === text ? bytes : null;
}

/**
 * Verify a token the way the app does: signature over the raw payload bytes, with the raw
 * 32-byte public key. Used by the tests and available to tools; the server itself never
 * needs to verify its own tokens.
 */
export function verifyToken(token: string, rawPublicKey: Buffer): TokenCheck {
  const parts = token.split('.');
  if (parts.length !== 2) return { valid: false, reason: 'token must have two parts separated by a dot' };
  const payloadBytes = decodeBase64url(parts[0]!);
  const signature = decodeBase64url(parts[1]!);
  if (payloadBytes === null) return { valid: false, reason: 'payload is not canonical base64url' };
  if (signature === null) return { valid: false, reason: 'signature is not canonical base64url' };
  if (signature.length !== 64) return { valid: false, reason: 'signature must be 64 bytes' };
  if (rawPublicKey.length !== 32) return { valid: false, reason: 'public key must be 32 bytes' };

  const publicKey = createPublicKey({
    key: { kty: 'OKP', crv: 'Ed25519', x: rawPublicKey.toString('base64url') },
    format: 'jwk',
  });
  if (!verify(null, payloadBytes, publicKey, signature)) {
    return { valid: false, reason: 'signature does not match the payload' };
  }
  try {
    return { valid: true, payload: JSON.parse(payloadBytes.toString('utf8')) as TokenPayload };
  } catch {
    return { valid: false, reason: 'payload is not JSON' };
  }
}
