// Public site routes under /api/* (proxied from the marketing hostname in production).
// Trial leads, pay config (prices), share-discount submit. No auth. Strict rate limits.

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from '../context.ts';
import { selectOne, write } from '../db/pool.ts';
import { parseMailConfig } from '../emails/mail-config.ts';
import { sendError, sendOk, sendRateLimited } from '../http/respond.ts';
import { lifetimePriceAfterCoupon, normalizeCouponCode, validateLifetimeCoupon } from '../services/coupons.ts';
import { fulfilPurchase, maskEmail } from '../services/fulfil.ts';
import { getCheckout, newDevOrderId, quoteAmount, recordCheckout } from '../services/pay.ts';
import { capturePayPalOrder, createPayPalOrder, readPayPalConfig } from '../services/paypal.ts';
import { submitSocialShare } from '../services/social-share.ts';
import { submitTrialLead } from '../services/trial-leads.ts';
import type { LicensePlan } from '../services/licenses.ts';

const BODY_LIMIT_BYTES = 8 * 1024;

const emailField = {
  type: 'string',
  minLength: 3,
  maxLength: 254,
  pattern: '^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$',
} as const;

const trialLeadBody = {
  type: 'object',
  additionalProperties: false,
  required: ['email'],
  properties: {
    email: emailField,
    /** Honeypot: bots fill this; humans leave it empty. */
    company: { type: 'string', maxLength: 200 },
  },
} as const;

interface TrialLeadBody {
  email: string;
  company?: string;
}

export const publicRoutes: FastifyPluginAsync<{ ctx: AppContext }> = async (app, { ctx }) => {
  const { clock, rateLimiter } = ctx;

  const limitByIp = async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | void> => {
    const decision = rateLimiter.hit(`trial-lead-ip:${request.ip}`, 20, clock.now());
    if (!decision.allowed) {
      return sendRateLimited(reply, clock, decision.retryAfterSec);
    }
  };

  const handleLead = async (
    request: FastifyRequest<{ Body: TrialLeadBody }>,
    reply: FastifyReply,
    resend: boolean,
  ) => {
    // Honeypot: pretend success so scrapers learn nothing.
    if (typeof request.body.company === 'string' && request.body.company.trim() !== '') {
      return sendOk(reply, clock, { status: 'mailed', email: request.body.email.trim().toLowerCase() });
    }

    const emailKey = request.body.email.trim().toLowerCase();
    const perEmail = rateLimiter.hit(`trial-lead-email:${emailKey}`, 8, clock.now());
    if (!perEmail.allowed) {
      return sendRateLimited(reply, clock, perEmail.retryAfterSec);
    }

    const uaHeader = request.headers['user-agent'];
    const userAgent = typeof uaHeader === 'string' ? uaHeader : null;

    const outcome = await submitTrialLead(ctx, {
      email: request.body.email,
      ip: request.ip,
      userAgent,
      resend,
    });

    if (!outcome.ok) {
      if (outcome.error === 'invalid_email') {
        return sendError(reply, clock, 'bad_request', {}, outcome.message ?? 'Enter a valid email address.');
      }
      return sendRateLimited(reply, clock, outcome.retryAfterSec ?? 120);
    }

    return sendOk(reply, clock, {
      status: outcome.status,
      email: outcome.email,
      download_url: outcome.downloadUrl,
    });
  };

  app.post<{ Body: TrialLeadBody }>(
    '/trial-lead',
    { bodyLimit: BODY_LIMIT_BYTES, onRequest: limitByIp, schema: { body: trialLeadBody } },
    async (request, reply) => handleLead(request, reply, false),
  );

  app.post<{ Body: TrialLeadBody }>(
    '/trial-lead/resend',
    { bodyLimit: BODY_LIMIT_BYTES, onRequest: limitByIp, schema: { body: trialLeadBody } },
    async (request, reply) => handleLead(request, reply, true),
  );

  /** Public prices + whether PayPal or local DEV checkout is available. */
  app.get('/pay/config', async (_request, reply) => {
    const monthly = await selectOne<{ value: string }>(ctx.db, "SELECT value FROM settings WHERE name = 'price_monthly'");
    const lifetime = await selectOne<{ value: string }>(
      ctx.db,
      "SELECT value FROM settings WHERE name = 'price_lifetime'",
    );
    const monthlyUsd = monthly?.value && /^\d+(\.\d{1,2})?$/.test(monthly.value) ? Number(monthly.value).toFixed(2) : '3.00';
    const lifetimeUsd =
      lifetime?.value && /^\d+(\.\d{1,2})?$/.test(lifetime.value) ? Number(lifetime.value).toFixed(2) : '15.00';
    const paypal = readPayPalConfig();
    return sendOk(reply, clock, {
      currency: 'USD',
      prices: { monthly: monthlyUsd, lifetime: lifetimeUsd },
      coupon_max_percent: 20,
      coupon_plans: ['lifetime'],
      paypal_client_id: paypal?.clientId ?? null,
      paypal_ready: paypal !== null,
      paypal_mode: paypal?.mode ?? null,
      dev_checkout: paypal === null && process.env.NODE_ENV !== 'production',
    });
  });

  const orderBody = {
    type: 'object',
    additionalProperties: false,
    required: ['plan'],
    properties: {
      plan: { type: 'string', enum: ['monthly', 'lifetime'] },
      coupon_code: { type: 'string', maxLength: 40 },
    },
  } as const;

  app.post<{ Body: { plan: LicensePlan; coupon_code?: string } }>(
    '/pay/orders',
    {
      bodyLimit: BODY_LIMIT_BYTES,
      onRequest: async (request, reply) => {
        const decision = rateLimiter.hit(`pay-order-ip:${request.ip}`, 20, clock.now());
        if (!decision.allowed) return sendRateLimited(reply, clock, decision.retryAfterSec);
      },
      schema: { body: orderBody },
    },
    async (request, reply) => {
      const paypal = readPayPalConfig();
      if (!paypal) {
        return sendError(
          reply,
          clock,
          'bad_request',
          {},
          'PayPal is not configured. Use local DEV checkout, or set PAYPAL_CLIENT_ID and PAYPAL_SECRET.',
        );
      }

      let quote;
      try {
        const coupon =
          typeof request.body.coupon_code === 'string' && request.body.coupon_code.trim() !== ''
            ? normalizeCouponCode(request.body.coupon_code)
            : null;
        if (typeof request.body.coupon_code === 'string' && request.body.coupon_code.trim() !== '' && !coupon) {
          return sendError(reply, clock, 'bad_request', {}, 'That coupon code does not look valid.');
        }
        quote = await quoteAmount(ctx.db, request.body.plan, coupon, clock.now());
      } catch (err) {
        return sendError(reply, clock, 'bad_request', {}, err instanceof Error ? err.message : 'Invalid coupon.');
      }

      const site = process.env.SITE_URL?.trim() || 'http://127.0.0.1:4312';
      let order;
      try {
        order = await createPayPalOrder(paypal, {
          amount: quote.amount,
          currency: 'USD',
          plan: request.body.plan,
          returnUrl: `${site}/#pricing`,
          cancelUrl: `${site}/#pricing`,
        });
      } catch (err) {
        request.log.error({ err }, 'paypal create order failed');
        return sendError(reply, clock, 'server_error', {}, 'PayPal could not start checkout.');
      }

      await recordCheckout(ctx.db, {
        orderId: order.id,
        plan: request.body.plan,
        amount: quote.amount,
        currency: 'USD',
        couponCode: quote.couponCode,
      });

      return sendOk(reply, clock, {
        order_id: order.id,
        amount: quote.amount,
        currency: 'USD',
        plan: request.body.plan,
        coupon_code: quote.couponCode,
        coupon_percent: quote.percent,
      });
    },
  );

  app.post<{ Params: { orderId: string } }>(
    '/pay/orders/:orderId/capture',
    {
      bodyLimit: BODY_LIMIT_BYTES,
      onRequest: async (request, reply) => {
        const decision = rateLimiter.hit(`pay-capture-ip:${request.ip}`, 20, clock.now());
        if (!decision.allowed) return sendRateLimited(reply, clock, decision.retryAfterSec);
      },
    },
    async (request, reply) => {
      const paypal = readPayPalConfig();
      if (!paypal) {
        return sendError(reply, clock, 'bad_request', {}, 'PayPal is not configured.');
      }

      const checkout = await getCheckout(ctx.db, request.params.orderId);
      if (!checkout) return sendError(reply, clock, 'not_found', {}, 'Checkout not found.');

      let capture;
      try {
        capture = await capturePayPalOrder(paypal, request.params.orderId);
      } catch (err) {
        request.log.error({ err }, 'paypal capture failed');
        return sendError(reply, clock, 'bad_request', {}, 'PayPal capture failed.');
      }

      if (Number(capture.amount).toFixed(2) !== Number(checkout.amount).toFixed(2)) {
        return sendError(
          reply,
          clock,
          'bad_request',
          {},
          `Captured amount ${capture.amount} does not match checkout ${checkout.amount}.`,
        );
      }

      const mail = parseMailConfig();
      let fulfilled;
      try {
        fulfilled = await fulfilPurchase(
          { db: ctx.db, cipher: ctx.keyCipher, mail, now: clock.now() },
          {
            paypalId: capture.id,
            plan: checkout.plan,
            amount: checkout.amount,
            currency: checkout.currency,
            payerEmail: capture.payerEmail,
            payerId: capture.payerId,
            couponCode: checkout.coupon_code,
            provider: 'paypal',
            rawJson: JSON.stringify(capture.raw),
          },
        );
      } catch (err) {
        request.log.error({ err }, 'fulfil after capture failed');
        return sendError(reply, clock, 'server_error', {}, err instanceof Error ? err.message : 'Fulfilment failed.');
      }

      await write(ctx.db, `UPDATE checkouts SET status = 'COMPLETED' WHERE paypal_order_id = ?`, [
        request.params.orderId,
      ]);

      return sendOk(reply, clock, {
        ok: true,
        plan: fulfilled.plan,
        amount: fulfilled.amount,
        invoice_number: fulfilled.invoiceNumber,
        email: maskEmail(fulfilled.email),
        already_fulfilled: fulfilled.alreadyFulfilled,
        note: 'License key and invoice PDF were emailed to your PayPal address.',
      });
    },
  );

  const devPurchaseBody = {
    type: 'object',
    additionalProperties: false,
    required: ['plan', 'payer_email'],
    properties: {
      plan: { type: 'string', enum: ['monthly', 'lifetime'] },
      payer_email: emailField,
      coupon_code: { type: 'string', maxLength: 40 },
    },
  } as const;

  /** Local-only buy path when PayPal credentials are absent. Issues key + invoice like a real capture. */
  app.post<{ Body: { plan: LicensePlan; payer_email: string; coupon_code?: string } }>(
    '/pay/dev-purchase',
    {
      bodyLimit: BODY_LIMIT_BYTES,
      onRequest: async (request, reply) => {
        const decision = rateLimiter.hit(`pay-dev-ip:${request.ip}`, 10, clock.now());
        if (!decision.allowed) return sendRateLimited(reply, clock, decision.retryAfterSec);
      },
      schema: { body: devPurchaseBody },
    },
    async (request, reply) => {
      if (readPayPalConfig() !== null) {
        return sendError(reply, clock, 'bad_request', {}, 'PayPal is configured; use the real checkout.');
      }
      if (process.env.NODE_ENV === 'production') {
        return sendError(reply, clock, 'forbidden', {}, 'DEV checkout is disabled in production.');
      }

      let quote;
      try {
        const coupon =
          typeof request.body.coupon_code === 'string' && request.body.coupon_code.trim() !== ''
            ? normalizeCouponCode(request.body.coupon_code)
            : null;
        if (typeof request.body.coupon_code === 'string' && request.body.coupon_code.trim() !== '' && !coupon) {
          return sendError(reply, clock, 'bad_request', {}, 'That coupon code does not look valid.');
        }
        quote = await quoteAmount(ctx.db, request.body.plan, coupon, clock.now());
      } catch (err) {
        return sendError(reply, clock, 'bad_request', {}, err instanceof Error ? err.message : 'Invalid coupon.');
      }

      const orderId = newDevOrderId();
      await recordCheckout(ctx.db, {
        orderId,
        plan: request.body.plan,
        amount: quote.amount,
        currency: 'USD',
        couponCode: quote.couponCode,
      });

      const mail = parseMailConfig();
      let fulfilled;
      try {
        fulfilled = await fulfilPurchase(
          { db: ctx.db, cipher: ctx.keyCipher, mail, now: clock.now() },
          {
            paypalId: orderId,
            plan: request.body.plan,
            amount: quote.amount,
            currency: 'USD',
            payerEmail: request.body.payer_email.trim().toLowerCase(),
            payerId: 'DEV-PAYER',
            couponCode: quote.couponCode,
            provider: 'manual',
            rawJson: JSON.stringify({ mode: 'dev-purchase', coupon: quote.couponCode }),
          },
        );
      } catch (err) {
        request.log.error({ err }, 'dev purchase fulfil failed');
        return sendError(reply, clock, 'bad_request', {}, err instanceof Error ? err.message : 'Purchase failed.');
      }

      await write(ctx.db, `UPDATE checkouts SET status = 'COMPLETED' WHERE paypal_order_id = ?`, [orderId]);

      return sendOk(reply, clock, {
        ok: true,
        mode: 'dev',
        order_id: orderId,
        plan: fulfilled.plan,
        amount: fulfilled.amount,
        invoice_number: fulfilled.invoiceNumber,
        email: maskEmail(fulfilled.email),
        key: fulfilled.key,
        already_fulfilled: fulfilled.alreadyFulfilled,
        note: 'DEV purchase: key + invoice were written under MAIL_DIR (and returned here for local testing).',
      });
    },
  );

  const couponValidateBody = {
    type: 'object',
    additionalProperties: false,
    required: ['code', 'plan'],
    properties: {
      code: { type: 'string', minLength: 6, maxLength: 40 },
      plan: { type: 'string', enum: ['monthly', 'lifetime'] },
    },
  } as const;

  app.post<{ Body: { code: string; plan: 'monthly' | 'lifetime' } }>(
    '/pay/coupons/validate',
    {
      bodyLimit: BODY_LIMIT_BYTES,
      onRequest: async (request, reply) => {
        const decision = rateLimiter.hit(`coupon-validate-ip:${request.ip}`, 30, clock.now());
        if (!decision.allowed) return sendRateLimited(reply, clock, decision.retryAfterSec);
      },
      schema: { body: couponValidateBody },
    },
    async (request, reply) => {
      if (request.body.plan !== 'lifetime') {
        return sendOk(reply, clock, {
          ok: false,
          message: 'Coupons apply only to Lifetime.',
        });
      }
      const lifetime = await selectOne<{ value: string }>(
        ctx.db,
        "SELECT value FROM settings WHERE name = 'price_lifetime'",
      );
      const list = lifetime?.value && /^\d+(\.\d{1,2})?$/.test(lifetime.value) ? Number(lifetime.value) : 15;
      const result = await validateLifetimeCoupon(ctx.db, request.body.code, list, clock.now());
      if (!result.ok) return sendOk(reply, clock, { ok: false, message: result.message });
      return sendOk(reply, clock, {
        ok: true,
        percent: result.percent,
        amount_after: result.amountAfter,
        amount_before: list.toFixed(2),
      });
    },
  );

  const discountBody = {
    type: 'object',
    additionalProperties: false,
    required: ['email'],
    properties: {
      email: emailField,
      linkedin_url: { type: 'string', maxLength: 512 },
      facebook_url: { type: 'string', maxLength: 512 },
      instagram_url: { type: 'string', maxLength: 512 },
      instagram_profile_url: { type: 'string', maxLength: 512 },
      x_url: { type: 'string', maxLength: 512 },
      company: { type: 'string', maxLength: 200 },
    },
  } as const;

  interface DiscountBody {
    email: string;
    linkedin_url?: string;
    facebook_url?: string;
    instagram_url?: string;
    instagram_profile_url?: string;
    x_url?: string;
    company?: string;
  }

  app.post<{ Body: DiscountBody }>(
    '/discount/submit',
    {
      bodyLimit: BODY_LIMIT_BYTES,
      onRequest: async (request, reply) => {
        const decision = rateLimiter.hit(`discount-ip:${request.ip}`, 12, clock.now());
        if (!decision.allowed) return sendRateLimited(reply, clock, decision.retryAfterSec);
      },
      schema: { body: discountBody },
    },
    async (request, reply) => {
      if (typeof request.body.company === 'string' && request.body.company.trim() !== '') {
        return sendOk(reply, clock, {
          coupon_code: 'NOS-SHARE-XXXX-XXXX',
          percent: 5,
          networks: 1,
        });
      }

      const emailKey = request.body.email.trim().toLowerCase();
      const perEmail = rateLimiter.hit(`discount-email:${emailKey}`, 5, clock.now());
      if (!perEmail.allowed) return sendRateLimited(reply, clock, perEmail.retryAfterSec);

      const outcome = await submitSocialShare(ctx.db, {
        email: request.body.email,
        linkedinUrl: request.body.linkedin_url,
        facebookUrl: request.body.facebook_url,
        instagramUrl: request.body.instagram_url,
        instagramProfileUrl: request.body.instagram_profile_url,
        xUrl: request.body.x_url,
      });

      if (!outcome.ok) {
        return sendError(reply, clock, 'bad_request', {}, outcome.message);
      }

      return sendOk(reply, clock, {
        coupon_code: outcome.couponCode,
        percent: outcome.percent,
        networks: outcome.networks,
        email: outcome.email,
        amount_after: lifetimePriceAfterCoupon(15, outcome.percent),
        note: 'Lifetime only. One-time code. Binds to your PayPal email when you buy.',
      });
    },
  );
};
