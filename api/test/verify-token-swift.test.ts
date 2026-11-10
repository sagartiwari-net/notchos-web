// LICENSE plan test row 5, across languages: a token signed by this server (Node crypto)
// verifies in Swift with CryptoKit, and an edited token does not. Runs
// scripts/verify-token.swift exactly as documented; skipped where no Swift toolchain exists.

import { execFile, execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSigner } from '../src/crypto/signing.ts';
import type { Harness } from './helpers/harness.ts';
import { createHarness, deviceId } from './helpers/harness.ts';

const SCRIPT = join(import.meta.dirname, '..', '..', 'scripts', 'verify-token.swift');

function swiftAvailable(): boolean {
  try {
    execFileSync('swift', ['--version'], { stdio: 'ignore', timeout: 30_000 });
    return true;
  } catch {
    return false;
  }
}

interface Run {
  code: number;
  stdout: string;
}

function verifyInSwift(token: string, publicKeyBase64: string): Promise<Run> {
  return new Promise((resolve, reject) => {
    execFile('swift', [SCRIPT, token, publicKeyBase64], { timeout: 120_000 }, (error, stdout) => {
      if (error !== null && typeof error.code !== 'number') reject(error);
      else resolve({ code: error === null ? 0 : (error.code as number), stdout });
    });
  });
}

const BASE64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

describe.skipIf(!swiftAvailable())('scripts/verify-token.swift (CryptoKit)', () => {
  let h: Harness;
  let token: string;
  let publicKey: string;

  beforeAll(async () => {
    h = await createHarness();
    const license = await h.newLicense('monthly', { days: 30 });
    const res = await h.post('/v1/activate', { email: 'buyer@example.com', key: license.key, device_id: deviceId('swift-mac') });
    token = res.body.token;
    publicKey = h.ctx.signer.publicKeyBase64;
  });
  afterAll(async () => {
    await h.close();
  });

  it('accepts a real server token and rejects edited ones', async () => {
    const [payloadPart, signaturePart] = token.split('.') as [string, string];
    const payloadJson = Buffer.from(payloadPart, 'base64url').toString('utf8');

    // 1. Someone edits expires_at inside the token and keeps the signature.
    const edited = JSON.parse(payloadJson);
    edited.expires_at = '2099-01-01T00:00:00Z';
    edited.refresh_by = '2099-01-01T00:00:00Z';
    const editedDate = `${Buffer.from(JSON.stringify(edited)).toString('base64url')}.${signaturePart}`;

    // 2. One character of the token is changed.
    const position = 30;
    const oneCharacter = `${token.slice(0, position)}${token[position] === 'A' ? 'B' : 'A'}${token.slice(position + 1)}`;

    // 3. The last character is replaced by one that decodes to the same bytes.
    const last = BASE64URL.indexOf(signaturePart.at(-1)!);
    const respelled = `${token.slice(0, -1)}${BASE64URL[last ^ 1]}`;
    expect(Buffer.from(respelled.split('.')[1]!, 'base64url').equals(Buffer.from(signaturePart, 'base64url'))).toBe(true);

    // 4. The right token, checked against some other public key.
    const otherKey = createSigner(generateKeyPairSync('ed25519').privateKey).publicKeyBase64;

    const [real, withEditedDate, withOneCharacter, withRespelling, withOtherKey] = await Promise.all([
      verifyInSwift(token, publicKey),
      verifyInSwift(editedDate, publicKey),
      verifyInSwift(oneCharacter, publicKey),
      verifyInSwift(respelled, publicKey),
      verifyInSwift(token, otherKey),
    ]);

    expect(real).toEqual({ code: 0, stdout: `payload: ${payloadJson}\nVALID\n` });

    expect(withEditedDate.code).toBe(1);
    expect(withEditedDate.stdout).toContain('"expires_at":"2099-01-01T00:00:00Z"');
    expect(withEditedDate.stdout).toContain('INVALID: the signature does not match the payload');

    expect(withOneCharacter.code).toBe(1);
    expect(withOneCharacter.stdout).toMatch(/INVALID: /);
    expect(withOneCharacter.stdout).not.toContain('\nVALID');

    expect(withRespelling.code).toBe(1);
    expect(withRespelling.stdout).toContain('INVALID: the signature part is not canonical base64url');

    expect(withOtherKey.code).toBe(1);
    expect(withOtherKey.stdout).toContain('INVALID: the signature does not match the payload');
  }, 180_000);
});
