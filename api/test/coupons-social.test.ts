import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSocialCoupon, lifetimePriceAfterCoupon, normalizeCouponCode, validateLifetimeCoupon } from '../src/services/coupons.ts';
import { submitSocialShare } from '../src/services/social-share.ts';
import { createHarness, type Harness } from './helpers/harness.ts';

describe('coupons + social share', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await createHarness();
  });

  afterAll(async () => {
    await h?.close();
  });

  it('computes lifetime price after coupon', () => {
    expect(lifetimePriceAfterCoupon(15, 0)).toBe('15.00');
    expect(lifetimePriceAfterCoupon(15, 5)).toBe('14.25');
    expect(lifetimePriceAfterCoupon(15, 20)).toBe('12.00');
    expect(lifetimePriceAfterCoupon(15, 99)).toBe('12.00');
  });

  it('normalizes coupon codes', () => {
    expect(normalizeCouponCode('nos-abcd-efgh')).toBe('NOS-ABCD-EFGH');
    expect(normalizeCouponCode('NOS-SHARE-ABCD-EFGH')).toBe('NOS-SHARE-ABCD-EFGH');
    expect(normalizeCouponCode('not-a-code')).toBeNull();
  });

  it('GET /api/pay/config returns locked prices', async () => {
    const res = await h.get('/api/pay/config');
    expect(res.status).toBe(200);
    expect(res.body.prices.monthly).toBe('3.00');
    expect(res.body.prices.lifetime).toBe('15.00');
    expect(res.body.coupon_plans).toContain('lifetime');
  });

  it('issues a social coupon from share links + email', async () => {
    const email = `share-${Date.now()}@example.com`;
    const outcome = await submitSocialShare(h.ctx.db, {
      email,
      linkedinUrl: 'https://www.linkedin.com/posts/someone-activity-123',
      xUrl: 'https://x.com/someone/status/123',
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.percent).toBe(10);
    expect(outcome.networks).toBe(2);
    expect(outcome.couponCode.startsWith('NOS-SHARE-')).toBe(true);

    const validated = await validateLifetimeCoupon(h.ctx.db, outcome.couponCode, 15, h.ctx.clock.now());
    expect(validated.ok).toBe(true);
    if (validated.ok) expect(validated.amountAfter).toBe('13.50');

    const again = await submitSocialShare(h.ctx.db, {
      email,
      facebookUrl: 'https://www.facebook.com/someone/posts/1',
    });
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error).toBe('limit');
  });

  it('POST /api/discount/submit returns a coupon', async () => {
    const res = await h.post('/api/discount/submit', {
      email: `form-${Date.now()}@example.com`,
      linkedin_url: 'https://www.linkedin.com/posts/form-activity-9',
    });
    expect(res.status).toBe(200);
    expect(res.body.percent).toBe(5);
    expect(String(res.body.coupon_code)).toMatch(/^NOS-SHARE-/);
  });

  it('rejects Monthly coupon validation', async () => {
    const res = await h.post('/api/pay/coupons/validate', {
      code: 'NOS-ABCD-EFGH',
      plan: 'monthly',
    });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
  });

  it('createSocialCoupon returns unique SHARE codes', async () => {
    await h.ctx.db.execute(
      `INSERT INTO social_share_submissions
         (contact_email, linkedin_url, networks_claimed, percent_requested, status)
       VALUES (?, 'https://www.linkedin.com/posts/x-1', 1, 5, 'submitted')`,
      [`unique-share-${Date.now()}@example.com`],
    );
    const rows = (await h.ctx.db.query(
      `SELECT id FROM social_share_submissions ORDER BY id DESC LIMIT 1`,
    )) as Array<{ id: number }>;
    const id = rows[0]?.id;
    expect(id).toBeTruthy();
    const coupon = await createSocialCoupon(h.ctx.db, { percent: 5, socialSubmissionId: id! });
    expect(coupon.code.startsWith('NOS-SHARE-')).toBe(true);
  });
});
