// Generate the Ed25519 key that signs activation tokens.
//
//   node scripts/gen-signing-key.ts [--out DIR]
//
// Writes, into ~/.notchos-dev/signing unless --out names another directory:
//   ed25519-private.pem   PKCS#8 private key, mode 600. This is what SIGNING_KEY_FILE points at.
//   ed25519-public.txt    the kid and the raw 32-byte public key in base64 (both public).
// and prints the kid and the public key: the two values the Mac app embeds.
//
// It never overwrites a key. If one exists it only prints that key's kid and public key.
// To replace a key on purpose, move the old file away first; every token signed with it
// stops verifying in apps that do not carry its public key.
//
// Runs on plain Node 24 (built-in TypeScript support, Node modules only): no install step.
// For production, run it on the server with --out pointing outside every web root, and
// keep one offline copy of the private key.

import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const PRIVATE_FILE = 'ed25519-private.pem';
const PUBLIC_FILE = 'ed25519-public.txt';

function rawPublicKey(privateKey: KeyObject): Buffer {
  const jwk = createPublicKey(privateKey).export({ format: 'jwk' });
  if (typeof jwk.x !== 'string') throw new Error('cannot read the Ed25519 public key');
  return Buffer.from(jwk.x, 'base64url');
}

/** Same rule as api/src/crypto/signing.ts: first 16 hex characters of SHA-256(raw public key). */
function kidFor(publicKey: Buffer): string {
  return createHash('sha256').update(publicKey).digest('hex').slice(0, 16);
}

function main(): void {
  const { values } = parseArgs({ options: { out: { type: 'string' } }, strict: true });
  const dir = resolve(values.out ?? join(homedir(), '.notchos-dev', 'signing'));
  const privatePath = join(dir, PRIVATE_FILE);
  const publicPath = join(dir, PUBLIC_FILE);

  let privateKey: KeyObject;
  let created = false;
  if (existsSync(privatePath)) {
    privateKey = createPrivateKey(readFileSync(privatePath));
    if (privateKey.asymmetricKeyType !== 'ed25519') {
      throw new Error(`${privatePath} exists but is not an Ed25519 key`);
    }
  } else {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    privateKey = generateKeyPairSync('ed25519').privateKey;
    const pem = privateKey.export({ format: 'pem', type: 'pkcs8' });
    // 'wx' fails if the file appeared in the meantime: a key is never overwritten.
    writeFileSync(privatePath, pem, { mode: 0o600, flag: 'wx' });
    chmodSync(privatePath, 0o600);
    created = true;
  }

  const publicKey = rawPublicKey(privateKey);
  const kid = kidFor(publicKey);
  const publicKeyBase64 = publicKey.toString('base64');
  writeFileSync(publicPath, `kid=${kid}\npublic_key_base64=${publicKeyBase64}\n`, { mode: 0o644 });

  console.log(created ? 'New Ed25519 signing key created.' : 'A signing key already exists; nothing was changed.');
  console.log(`  private key  ${privatePath}  (secret, mode 600)`);
  console.log(`  public info  ${publicPath}`);
  console.log('');
  console.log('For the app (both values are public):');
  console.log(`  kid                 ${kid}`);
  console.log(`  public key (base64) ${publicKeyBase64}`);
}

try {
  main();
} catch (err) {
  console.error(`gen-signing-key: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
