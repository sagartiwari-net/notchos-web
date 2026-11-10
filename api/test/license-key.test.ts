import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  generateLicenseKey,
  hashLicenseKey,
  KEY_ALPHABET,
  LicenseKeyCipher,
  licenseKeyHint,
  normalizeLicenseKey,
  safeEqual,
} from '../src/crypto/license-key.ts';

describe('license key generator', () => {
  it('produces NOS-XXXXX-XXXXX-XXXXX-XXXXX', () => {
    for (let i = 0; i < 200; i++) {
      expect(generateLicenseKey()).toMatch(/^NOS-[A-Z2-9]{5}-[A-Z2-9]{5}-[A-Z2-9]{5}-[A-Z2-9]{5}$/);
    }
  });

  it('never uses 0, O, 1 or I', () => {
    expect(KEY_ALPHABET).toHaveLength(32);
    expect(new Set(KEY_ALPHABET).size).toBe(32);
    for (const forbidden of ['0', 'O', '1', 'I']) expect(KEY_ALPHABET).not.toContain(forbidden);

    const random = Array.from({ length: 2000 }, () => generateLicenseKey().slice(4).replaceAll('-', '')).join('');
    expect(random).not.toMatch(/[0O1I]/);
    // 40,000 random characters: every one of the 32 symbols shows up.
    expect(new Set(random).size).toBe(32);
  });

  it('does not repeat', () => {
    const keys = new Set(Array.from({ length: 5000 }, () => generateLicenseKey()));
    expect(keys.size).toBe(5000);
  });
});

describe('normalizeLicenseKey', () => {
  const key = 'NOS-7K2QF-M9XPA-4HRTD-W8ZC3';

  it('accepts the key as printed', () => {
    expect(normalizeLicenseKey(key)).toBe(key);
  });

  it('ignores case, spaces and dash style', () => {
    expect(normalizeLicenseKey('nos-7k2qf-m9xpa-4hrtd-w8zc3')).toBe(key);
    expect(normalizeLicenseKey('  NOS 7K2QF M9XPA 4HRTD W8ZC3\n')).toBe(key);
    expect(normalizeLicenseKey('NOS7K2QFM9XPA4HRTDW8ZC3')).toBe(key);
    expect(normalizeLicenseKey('NOS\u20137K2QF\u2014M9XPA\u20114HRTD\u2212W8ZC3')).toBe(key);
  });

  it('rejects everything that cannot be a key', () => {
    const wrong = [
      '',
      'hello',
      'NOS-7K2QF-M9XPA-4HRTD-W8ZC', // one character short
      'NOS-7K2QF-M9XPA-4HRTD-W8ZC33', // one too many
      'NOX-7K2QF-M9XPA-4HRTD-W8ZC3', // wrong prefix
      'NOS-7K2QF-M9XPA-4HRTD-W8ZC0', // 0 is not in the alphabet
      'NOS-7K2QF-M9XPA-4HRTD-W8ZCO',
      'NOS-7K2QF-M9XPA-4HRTD-W8ZC1',
      'NOS-7K2QF-M9XPA-4HRTD-W8ZCI',
      "NOS-7K2QF-M9XPA-4HRTD-W8ZC3' OR '1'='1",
      'N'.repeat(5000),
      // Letters that only become valid through Unicode case mapping are not accepted:
      'NOS-7K2QF-M9XPA-4HRTD-W8Zß', // ß upper-cases to SS
      'NOſ-7K2QF-M9XPA-4HRTD-W8ZC3', // ſ (long s) upper-cases to S
      'ＮＯＳ-7K2QF-M9XPA-4HRTD-W8ZC3', // full-width letters
      'NOS-7\u212A2QF-M9XPA-4HRTD-W8ZC3', // KELVIN SIGN, lower-cases to k
    ];
    for (const text of wrong) expect(normalizeLicenseKey(text), text.slice(0, 40)).toBeNull();
  });
});

describe('hash and hint', () => {
  it('hashes the canonical key with SHA-256', () => {
    // Known answer from another tool:
    //   printf %s 'NOS-7K2QF-M9XPA-4HRTD-W8ZC3' | shasum -a 256
    expect(hashLicenseKey('NOS-7K2QF-M9XPA-4HRTD-W8ZC3')).toBe(
      '72dc64f7b75457a269f9070a9a97fcd94acfcfcaaf75fb0fdffe2690a7ea8499',
    );
    expect(hashLicenseKey('NOS-7K2QF-M9XPA-4HRTD-W8ZC3')).not.toBe(hashLicenseKey('NOS-7K2QF-M9XPA-4HRTD-W8ZC4'));
  });

  it('keeps the last 4 characters as the hint', () => {
    expect(licenseKeyHint('NOS-7K2QF-M9XPA-4HRTD-W8ZC3')).toBe('8ZC3');
  });
});

describe('LicenseKeyCipher (AES-256-GCM copy of the key)', () => {
  const key = generateLicenseKey();
  const keyHash = hashLicenseKey(key);

  it('round-trips and never contains the key in clear', () => {
    const cipher = new LicenseKeyCipher(randomBytes(32));
    const stored = cipher.encrypt(key, keyHash);
    expect(stored).toMatch(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(stored).not.toContain(key);
    expect(stored).not.toContain(key.replaceAll('-', ''));
    expect(stored.length).toBeLessThanOrEqual(255);
    expect(cipher.decrypt(stored, keyHash)).toBe(key);
  });

  it('uses a fresh nonce every time', () => {
    const cipher = new LicenseKeyCipher(randomBytes(32));
    expect(cipher.encrypt(key, keyHash)).not.toBe(cipher.encrypt(key, keyHash));
  });

  it('cannot be decrypted with another secret', () => {
    const stored = new LicenseKeyCipher(randomBytes(32)).encrypt(key, keyHash);
    expect(() => new LicenseKeyCipher(randomBytes(32)).decrypt(stored, keyHash)).toThrow(/cannot be decrypted/);
  });

  it('is bound to its row: another key hash does not decrypt it', () => {
    const cipher = new LicenseKeyCipher(randomBytes(32));
    const stored = cipher.encrypt(key, keyHash);
    const otherHash = hashLicenseKey(generateLicenseKey());
    expect(() => cipher.decrypt(stored, otherHash)).toThrow();
  });

  it('detects a modified ciphertext', () => {
    const cipher = new LicenseKeyCipher(randomBytes(32));
    const parts = cipher.encrypt(key, keyHash).split('.');
    const body = Buffer.from(parts[2]!, 'base64url');
    body[0] = body[0]! ^ 1;
    parts[2] = body.toString('base64url');
    expect(() => cipher.decrypt(parts.join('.'), keyHash)).toThrow();
  });

  it('rejects malformed stored values and wrong secret sizes', () => {
    const cipher = new LicenseKeyCipher(randomBytes(32));
    for (const bad of ['', 'v1', 'v2.a.b.c', 'v1.a.b', 'v1.a.b.c.d', 'plain-text']) {
      expect(() => cipher.decrypt(bad, keyHash), bad).toThrow(/unknown format/);
    }
    expect(() => new LicenseKeyCipher(randomBytes(16))).toThrow();
  });
});

describe('safeEqual', () => {
  it('compares buffers of equal content and refuses different lengths', () => {
    expect(safeEqual(Buffer.from('abc'), Buffer.from('abc'))).toBe(true);
    expect(safeEqual(Buffer.from('abc'), Buffer.from('abd'))).toBe(false);
    expect(safeEqual(Buffer.from('abc'), Buffer.from('abcd'))).toBe(false);
  });
});
