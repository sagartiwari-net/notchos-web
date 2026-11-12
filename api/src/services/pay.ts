// Checkout helpers: prices, checkout rows, and a local DEV purchase path until PayPal credentials exist.

import { randomBytes } from 'node:crypto';
import type { Db } from '../db/pool.ts';
import { selectOne, write } from '../db/pool.ts';
import { lifetimePriceAfterCoupon, normalizeCouponCode, validateLifetimeCoupon } from './coupons.ts';
import type { LicensePlan } from './licenses.ts';

export async function getCheckoutPrices(db: Db): Promise<{ monthly: string; lifetime: string }> {
  const monthly = await selectOne<{ value: string }>(db, "SELECT value FROM settings WHERE name = 'price_monthly'");
  const lifetime = await selectOne<{ value: string }>(db, "SELECT value FROM settings WHERE name = 'price_lifetime'");
  return {
    monthly: monthly?.value && /^\d+(\.\d{1,2})?$/.test(monthly.value) ? Number(monthly.value).toFixed(2) : '3.00',
    lifetime:
      lifetime?.value && /^\d+(\.\d{1,2})?$/.test(lifetime.value) ? Number(lifetime.value).toFixed(2) : '15.00',
  };
}

export function paypalConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.PAYPAL_CLIENT_ID?.trim() && env.PAYPAL_SECRET?.trim());
}

export async function quoteAmount(
  db: Db,
  plan: LicensePlan,
  couponCode: string | null,
  now: Date,
): Promise<{ amount: string; couponCode: string | null; percent: number | null }> {
  const prices = await getCheckoutPrices(db);
  if (plan === 'monthly') {
    if (couponCode) throw new Error('Coupons apply only to Lifetime.');
    return { amount: prices.monthly, couponCode: null, percent: null };
  }
  if (!couponCode) return { amount: prices.lifetime, couponCode: null, percent: null };
  const validated = await validateLifetimeCoupon(db, couponCode, Number(prices.lifetime), now);
  if (!validated.ok) throw new Error(validated.message);
  return { amount: validated.amountAfter, couponCode: validated.code, percent: validated.percent };
}

export async function recordCheckout(
  db: Db,
  input: { orderId: string; plan: LicensePlan; amount: string; currency: string; couponCode: string | null },
): Promise<void> {
  await write(
    db,
    `INSERT INTO checkouts (paypal_order_id, plan, amount, currency, coupon_code, status, created_at)
     VALUES (?, ?, ?, ?, ?, 'CREATED', CURRENT_TIMESTAMP)`,
    [input.orderId, input.plan, input.amount, input.currency, input.couponCode],
  );
}

export async function getCheckout(db: Db, orderId: string) {
  return selectOne<{
    paypal_order_id: string;
    plan: LicensePlan;
    amount: string;
    currency: string;
    coupon_code: string | null;
    status: string;
  }>(
    db,
    `SELECT paypal_order_id, plan, amount, currency, coupon_code, status
       FROM checkouts WHERE paypal_order_id = ?`,
    [orderId],
  );
}

export function newDevOrderId(): string {
  return `DEV-${randomBytes(12).toString('hex')}`;
}

export { lifetimePriceAfterCoupon, normalizeCouponCode };
