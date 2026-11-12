// Fulfil a paid checkout: payment row + license + coupon redeem + invoice + email.
// Idempotent on paypal_id (unique).

import { readFileSync } from 'node:fs';
import type { LicenseKeyCipher } from '../crypto/license-key.ts';
import type { Db } from '../db/pool.ts';
import { selectOne, withTransaction, write } from '../db/pool.ts';
import type { MailConfig } from '../emails/mail-config.ts';
import { sendTemplate } from '../emails/mailer.ts';
import { addDays } from '../lib/time.ts';
import { getCouponByCode, lifetimePriceAfterCoupon, normalizeCouponCode } from './coupons.ts';
import { createInvoice } from './invoices.ts';
import { createLicense, type LicensePlan } from './licenses.ts';

export interface FulfilInput {
  paypalId: string;
  plan: LicensePlan;
  amount: string;
  currency: string;
  payerEmail: string;
  payerId: string | null;
  couponCode: string | null;
  provider: 'paypal' | 'manual';
  rawJson?: string | null;
}

export interface FulfilResult {
  licenseId: number;
  key: string;
  email: string;
  plan: LicensePlan;
  invoiceNumber: string;
  amount: string;
  couponPercent: number | null;
  alreadyFulfilled: boolean;
}

async function readPrice(db: Db, name: 'price_monthly' | 'price_lifetime', fallback: string): Promise<string> {
  const row = await selectOne<{ value: string }>(db, 'SELECT value FROM settings WHERE name = ?', [name]);
  if (row && /^\d+(\.\d{1,2})?$/.test(row.value)) return Number(row.value).toFixed(2);
  return fallback;
}

export async function fulfilPurchase(
  deps: { db: Db; cipher: LicenseKeyCipher; mail: MailConfig; now: Date },
  input: FulfilInput,
): Promise<FulfilResult> {
  const existing = await selectOne<{ license_id: number | null; amount: string; payer_email: string | null }>(
    deps.db,
    'SELECT license_id, amount, payer_email FROM payments WHERE paypal_id = ?',
    [input.paypalId],
  );
  if (existing?.license_id) {
    const lic = await selectOne<{ id: number; email: string; plan: LicensePlan; key_enc: string; key_hash: string }>(
      deps.db,
      'SELECT id, email, plan, key_enc, key_hash FROM licenses WHERE id = ?',
      [existing.license_id],
    );
    if (lic) {
      const inv = await selectOne<{ number: string }>(
        deps.db,
        'SELECT number FROM invoices WHERE license_id = ? ORDER BY id DESC LIMIT 1',
        [lic.id],
      );
      return {
        licenseId: lic.id,
        key: deps.cipher.decrypt(lic.key_enc, lic.key_hash),
        email: lic.email,
        plan: lic.plan,
        invoiceNumber: inv?.number ?? '',
        amount: Number(existing.amount).toFixed(2),
        couponPercent: null,
        alreadyFulfilled: true,
      };
    }
  }

  const monthlyList = await readPrice(deps.db, 'price_monthly', '3.00');
  const lifetimeList = await readPrice(deps.db, 'price_lifetime', '15.00');

  let listAmount = input.plan === 'lifetime' ? lifetimeList : monthlyList;
  let couponPercent: number | null = null;
  let couponId: number | null = null;
  let expectedAmount = listAmount;

  if (input.couponCode) {
    if (input.plan !== 'lifetime') throw new Error('coupons are lifetime only');
    const code = normalizeCouponCode(input.couponCode);
    if (!code) throw new Error('invalid coupon');
    const coupon = await getCouponByCode(deps.db, code);
    if (!coupon || coupon.status !== 'active' || coupon.redemption_count >= coupon.max_redemptions) {
      throw new Error('coupon not usable');
    }
    if (coupon.expires_at && coupon.expires_at.getTime() <= deps.now.getTime()) throw new Error('coupon expired');
    couponPercent = coupon.percent;
    couponId = coupon.id;
    expectedAmount = lifetimePriceAfterCoupon(Number(lifetimeList), coupon.percent);
  }

  if (Number(input.amount).toFixed(2) !== Number(expectedAmount).toFixed(2)) {
    throw new Error(`amount mismatch: got ${input.amount}, expected ${expectedAmount}`);
  }

  const created = await withTransaction(deps.db, async (tx) => {
    const again = await selectOne<{ license_id: number | null }>(tx, 'SELECT license_id FROM payments WHERE paypal_id = ?', [
      input.paypalId,
    ]);
    if (again?.license_id) throw new Error('race: already fulfilled');

    const expiresAt = input.plan === 'monthly' ? addDays(deps.now, 30) : null;
    const license = await createLicense(
      tx,
      deps.cipher,
      {
        email: input.payerEmail,
        plan: input.plan,
        expiresAt,
        periodEnd: expiresAt,
        autoRenew: false,
        source: input.provider === 'paypal' ? 'paypal' : 'manual',
        payerId: input.payerId,
        note: input.couponCode ? `coupon ${input.couponCode}` : null,
      },
      deps.now,
    );

    const pay = await write(
      tx,
      `INSERT INTO payments
         (license_id, kind, paypal_id, amount, currency, payer_email, payer_id, status, raw_json, created_at)
       VALUES (?, 'order', ?, ?, ?, ?, ?, 'COMPLETED', ?, ?)`,
      [
        license.id,
        input.paypalId,
        expectedAmount,
        input.currency.toUpperCase(),
        input.payerEmail,
        input.payerId,
        input.rawJson ?? null,
        deps.now,
      ],
    );

    if (couponId !== null && couponPercent !== null) {
      await write(
        tx,
        `INSERT INTO coupon_redemptions
           (coupon_id, payment_id, license_id, payer_email, payer_id, amount_before, amount_after, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          couponId,
          pay.insertId,
          license.id,
          input.payerEmail,
          input.payerId,
          listAmount,
          expectedAmount,
          deps.now,
        ],
      );
      await write(
        tx,
        `UPDATE coupons
            SET redemption_count = redemption_count + 1,
                status = IF(redemption_count + 1 >= max_redemptions, 'used', status),
                updated_at = ?
          WHERE id = ? AND status = 'active' AND redemption_count < max_redemptions`,
        [deps.now, couponId],
      );
    }

    const discount = (Number(listAmount) - Number(expectedAmount)).toFixed(2);
    const invoice = await createInvoice(
      tx,
      {
        paymentId: pay.insertId,
        licenseId: license.id,
        payerEmail: input.payerEmail,
        plan: input.plan,
        listAmount,
        discountAmount: discount,
        totalAmount: expectedAmount,
        couponId,
        couponPercent,
        provider: input.provider === 'paypal' ? 'paypal' : 'manual',
      },
      deps.now,
      deps.mail.dir,
    );

    return { license, invoice, paymentId: pay.insertId, expectedAmount, couponPercent };
  });

  const template = input.plan === 'lifetime' ? 'purchase_lifetime' : 'purchase_monthly';
  let pdfAttachment: { filename: string; content: Buffer } | undefined;
  try {
    pdfAttachment = {
      filename: `${created.invoice.number}.pdf`,
      content: readFileSync(created.invoice.pdfPath),
    };
  } catch {
    pdfAttachment = undefined;
  }

  await sendTemplate(deps.mail, template, {
    email: input.payerEmail,
    key: created.license.key,
    expiresAt: created.license.expiresAt ? created.license.expiresAt.toISOString().slice(0, 10) : undefined,
  }, pdfAttachment);

  return {
    licenseId: created.license.id,
    key: created.license.key,
    email: input.payerEmail,
    plan: input.plan,
    invoiceNumber: created.invoice.number,
    amount: created.expectedAmount,
    couponPercent: created.couponPercent,
    alreadyFulfilled: false,
  };
}

export function maskEmail(email: string): string {
  const [user, domain] = email.split('@');
  if (!user || !domain) return '•••';
  const head = user.slice(0, 1);
  return `${head}•••@${domain}`;
}
