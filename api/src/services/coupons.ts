// Lifetime-only coupons (admin + social). Hard cap 20%. Single-use for social.

import { randomBytes } from 'node:crypto';
import type { Queryable } from '../db/pool.ts';
import { isDuplicateKeyError, selectOne, write } from '../db/pool.ts';

const COUPON_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export type CouponKind = 'admin' | 'social';
export type CouponStatus = 'active' | 'used' | 'expired' | 'void';

export interface CouponRow {
  id: number;
  code: string;
  kind: CouponKind;
  percent: number;
  plan_scope: 'lifetime';
  max_redemptions: number;
  redemption_count: number;
  status: CouponStatus;
  expires_at: Date | null;
  social_submission_id: number | null;
}

export function generateCouponCode(prefix = 'NOS'): string {
  let body = '';
  for (const byte of randomBytes(8)) body += COUPON_ALPHABET[byte % COUPON_ALPHABET.length];
  return `${prefix}-${body.slice(0, 4)}-${body.slice(4)}`;
}

export function normalizeCouponCode(raw: string): string | null {
  const compact = raw.trim().toUpperCase().replace(/[\s\-]+/g, '');
  if (!/^NOS[A-HJ-NP-Z2-9]{8}$/.test(compact) && !/^NOSSHARE[A-HJ-NP-Z2-9]{8}$/.test(compact)) {
    // Accept NOS-XXXX-XXXX and NOS-SHARE-XXXX-XXXX shaped input after strip.
  }
  const withDashes = raw.trim().toUpperCase().replace(/\s+/g, '');
  if (/^NOS-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/.test(withDashes)) return withDashes;
  if (/^NOS-SHARE-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/.test(withDashes)) return withDashes;
  // Rebuild from compact NOS + 8
  if (/^NOS[A-HJ-NP-Z2-9]{8}$/.test(compact)) {
    return `NOS-${compact.slice(3, 7)}-${compact.slice(7)}`;
  }
  if (/^NOSSHARE[A-HJ-NP-Z2-9]{8}$/.test(compact)) {
    return `NOS-SHARE-${compact.slice(8, 12)}-${compact.slice(12)}`;
  }
  return null;
}

export function lifetimePriceAfterCoupon(listUsd: number, percent: number): string {
  const pct = Math.min(20, Math.max(0, Math.floor(percent)));
  const after = Math.round(listUsd * (1 - pct / 100) * 100) / 100;
  return after.toFixed(2);
}

export async function getCouponByCode(q: Queryable, code: string): Promise<CouponRow | null> {
  return selectOne<CouponRow>(
    q,
    `SELECT id, code, kind, percent, plan_scope, max_redemptions, redemption_count, status,
            expires_at, social_submission_id
       FROM coupons WHERE code = ?`,
    [code],
  );
}

export type ValidateCouponResult =
  | { ok: true; code: string; percent: number; amountAfter: string }
  | { ok: false; message: string };

export async function validateLifetimeCoupon(
  q: Queryable,
  rawCode: string,
  lifetimeListUsd: number,
  now: Date,
): Promise<ValidateCouponResult> {
  const code = normalizeCouponCode(rawCode);
  if (code === null) return { ok: false, message: 'Enter a valid coupon code.' };

  const row = await getCouponByCode(q, code);
  if (row === null || row.status === 'void') {
    return { ok: false, message: 'This coupon is not valid.' };
  }
  if (row.status === 'used' || row.redemption_count >= row.max_redemptions) {
    return { ok: false, message: 'This coupon has already been used.' };
  }
  if (row.status === 'expired' || (row.expires_at !== null && row.expires_at.getTime() <= now.getTime())) {
    return { ok: false, message: 'This coupon has expired.' };
  }
  if (row.plan_scope !== 'lifetime') {
    return { ok: false, message: 'This coupon is only for Lifetime.' };
  }
  if (row.percent < 1 || row.percent > 20) {
    return { ok: false, message: 'This coupon is not valid.' };
  }

  return {
    ok: true,
    code: row.code,
    percent: row.percent,
    amountAfter: lifetimePriceAfterCoupon(lifetimeListUsd, row.percent),
  };
}

function randomShareCode(): string {
  let body = '';
  for (const byte of randomBytes(8)) body += COUPON_ALPHABET[byte % COUPON_ALPHABET.length];
  return `NOS-SHARE-${body.slice(0, 4)}-${body.slice(4)}`;
}

export async function createSocialCoupon(
  q: Queryable,
  input: { percent: number; socialSubmissionId: number },
): Promise<{ id: number; code: string }> {
  const percent = Math.min(20, Math.max(5, Math.floor(input.percent)));

  for (let attempt = 0; attempt < 5; attempt++) {
    const code = randomShareCode();
    try {
      const result = await write(
        q,
        `INSERT INTO coupons
           (code, kind, percent, plan_scope, max_redemptions, redemption_count, status, social_submission_id)
         VALUES (?, 'social', ?, 'lifetime', 1, 0, 'active', ?)`,
        [code, percent, input.socialSubmissionId],
      );
      return { id: Number(result.insertId), code };
    } catch (err) {
      if (!isDuplicateKeyError(err)) throw err;
    }
  }
  throw new Error('could not allocate coupon code');
}
