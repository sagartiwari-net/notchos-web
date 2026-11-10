import { execFileSync } from 'node:child_process';
import { createHash, createPublicKey, generateKeyPairSync, verify } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ConfigError } from '../src/config.ts';
import type { TokenClaims } from '../src/crypto/signing.ts';
import { createSigner, kidForPublicKey, loadSigner, verifyToken } from '../src/crypto/signing.ts';

const scratch = mkdtempSync(join(tmpdir(), 'notchos-signing-test-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const claims: TokenClaims = {
  license_id: 42,
  device_id: 'a'.repeat(64),
  plan: 'monthly',
  issued_at: '2026-11-10T08:00:00Z',
  expires_at: '2026-12-10T08:00:00Z',
  refresh_by: '2026-12-10T08:00:00Z',
};

describe('token signing', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const signer = createSigner(privateKey);
  const rawPublicKey = Buffer.from(signer.publicKeyBase64, 'base64');

  it('exposes the raw 32-byte public key and a kid derived from it', () => {
    expect(rawPublicKey).toHaveLength(32);
    // The same 32 bytes are the tail of the standard SPKI encoding of the public key.
    const spki = publicKey.export({ format: 'der', type: 'spki' });
    expect(spki.subarray(spki.length - 32).equals(rawPublicKey)).toBe(true);

    expect(signer.kid).toBe(createHash('sha256').update(rawPublicKey).digest('hex').slice(0, 16));
    expect(kidForPublicKey(rawPublicKey)).toBe(signer.kid);
  });

  it('builds base64url(payload).base64url(signature) without padding', () => {
    const token = signer.issue(claims);
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{86}$/);

    const [payloadPart, signaturePart] = token.split('.') as [string, string];
    const payloadBytes = Buffer.from(payloadPart, 'base64url');
    const signature = Buffer.from(signaturePart, 'base64url');
    expect(signature).toHaveLength(64);

    // The signature is over the exact payload bytes, checked here with Node's own verifier.
    expect(verify(null, payloadBytes, publicKey, signature)).toBe(true);
    expect(JSON.parse(payloadBytes.toString('utf8'))).toEqual({ kid: signer.kid, ...claims });
  });

  it('puts exactly the planned fields into the payload, kid included', () => {
    const payload = JSON.parse(Buffer.from(signer.issue(claims).split('.')[0]!, 'base64url').toString('utf8'));
    expect(Object.keys(payload)).toEqual([
      'kid',
      'license_id',
      'device_id',
      'plan',
      'issued_at',
      'expires_at',
      'refresh_by',
    ]);
  });

  it('verifies with the raw public key, the way the app does', () => {
    const check = verifyToken(signer.issue(claims), rawPublicKey);
    expect(check).toEqual({ valid: true, payload: { kid: signer.kid, ...claims } });
  });

  it('rejects a token whose payload was edited (LICENSE plan test row 5)', () => {
    const [payloadPart, signaturePart] = signer.issue(claims).split('.') as [string, string];
    const edited = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8'));
    edited.expires_at = '2036-12-10T08:00:00Z';
    const forged = `${Buffer.from(JSON.stringify(edited)).toString('base64url')}.${signaturePart}`;
    expect(verifyToken(forged, rawPublicKey)).toEqual({ valid: false, reason: 'signature does not match the payload' });
  });

  it('rejects every single-character change anywhere in the token', () => {
    const token = signer.issue(claims);
    for (let i = 0; i < token.length; i++) {
      if (token[i] === '.') continue;
      const replacement = token[i] === 'A' ? 'B' : 'A';
      const changed = token.slice(0, i) + replacement + token.slice(i + 1);
      expect(verifyToken(changed, rawPublicKey).valid, `position ${i}`).toBe(false);
    }
  });

  it('rejects a token signed by another key, and malformed tokens', () => {
    const other = createSigner(generateKeyPairSync('ed25519').privateKey);
    expect(verifyToken(other.issue(claims), rawPublicKey).valid).toBe(false);

    const token = signer.issue(claims);
    for (const bad of ['', 'abc', 'a.b.c', `${token}.x`, `.${token.split('.')[1]}`, `${token.split('.')[0]}.`, `${token}=`]) {
      expect(verifyToken(bad, rawPublicKey).valid, bad.slice(0, 20)).toBe(false);
    }
    expect(verifyToken(token, rawPublicKey.subarray(0, 31)).valid).toBe(false);
  });

  it('refuses a key that is not an Ed25519 private key', () => {
    expect(() => createSigner(publicKey)).toThrow(/Ed25519 private key/);
    expect(() => createSigner(generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey)).toThrow();
  });
});

describe('loading the signing key from a file', () => {
  const pem = generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' });

  it('loads a key file that only its owner can read', () => {
    const path = join(scratch, 'private-600.pem');
    writeFileSync(path, pem, { mode: 0o600 });
    chmodSync(path, 0o600);
    const signer = loadSigner(path);
    expect(verifyToken(signer.issue(claims), Buffer.from(signer.publicKeyBase64, 'base64')).valid).toBe(true);
  });

  it('refuses a key file that other users can read', () => {
    const path = join(scratch, 'private-644.pem');
    writeFileSync(path, pem, { mode: 0o644 });
    chmodSync(path, 0o644);
    expect(() => loadSigner(path)).toThrow(ConfigError);
    expect(() => loadSigner(path)).toThrow(/can be read by other users/);
  });

  it('gives a clear error for a missing or unusable file, without quoting its content', () => {
    expect(() => loadSigner(join(scratch, 'missing.pem'))).toThrow(/not found/);

    const garbage = join(scratch, 'garbage.pem');
    writeFileSync(garbage, 'SECRET-LOOKING-CONTENT', { mode: 0o600 });
    chmodSync(garbage, 0o600);
    let message = '';
    try {
      loadSigner(garbage);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/cannot read a private key/);
    expect(message).not.toContain('SECRET-LOOKING-CONTENT');
  });
});

describe('scripts/gen-signing-key.ts', () => {
  const script = join(import.meta.dirname, '..', '..', 'scripts', 'gen-signing-key.ts');
  const out = join(scratch, 'generated');
  const run = (): string => execFileSync(process.execPath, [script, '--out', out], { encoding: 'utf8' });

  it('writes a private key the API can load, and prints its kid and public key', () => {
    const printed = run();
    const signer = loadSigner(join(out, 'ed25519-private.pem'));

    expect(printed).toContain('New Ed25519 signing key created.');
    expect(printed).toContain(`kid                 ${signer.kid}`);
    expect(printed).toContain(`public key (base64) ${signer.publicKeyBase64}`);
    expect(Buffer.from(signer.publicKeyBase64, 'base64')).toHaveLength(32);
    expect(readFileSync(join(out, 'ed25519-public.txt'), 'utf8')).toBe(
      `kid=${signer.kid}\npublic_key_base64=${signer.publicKeyBase64}\n`,
    );
    // The private key never appears on stdout.
    const pemBody = readFileSync(join(out, 'ed25519-private.pem'), 'utf8').split('\n')[1]!;
    expect(printed).not.toContain(pemBody);

    // A token from this key verifies against the printed public key, as a JWK-built key too.
    const token = signer.issue(claims);
    const [payloadPart, signaturePart] = token.split('.') as [string, string];
    const fromPrinted = createPublicKey({
      key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(signer.publicKeyBase64, 'base64').toString('base64url') },
      format: 'jwk',
    });
    expect(
      verify(null, Buffer.from(payloadPart, 'base64url'), fromPrinted, Buffer.from(signaturePart, 'base64url')),
    ).toBe(true);
  });

  it('never overwrites an existing key', () => {
    const before = readFileSync(join(out, 'ed25519-private.pem'), 'utf8');
    const printed = run();
    expect(printed).toContain('A signing key already exists; nothing was changed.');
    expect(readFileSync(join(out, 'ed25519-private.pem'), 'utf8')).toBe(before);
  });
});
