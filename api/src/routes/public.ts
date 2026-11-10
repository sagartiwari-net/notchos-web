// Public site routes under /api/* (proxied from the marketing hostname in production).
// Today: trial lead email capture. No auth. Strict rate limits.

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from '../context.ts';
import { sendError, sendOk, sendRateLimited } from '../http/respond.ts';
import { submitTrialLead } from '../services/trial-leads.ts';

const BODY_LIMIT_BYTES = 2048;

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
};
