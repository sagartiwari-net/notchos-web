// Website trial leads: email capture + download mail. Does not start a device trial.
// See NOTCHOS-TRIAL-SEAT-PLAN.md.

import type { CoreContext } from '../context.ts';
import { isDuplicateKeyError, selectOne, withTransaction, write } from '../db/pool.ts';
import { logEmail } from '../emails/email-log.ts';
import { sendTemplate } from '../emails/mailer.ts';
import { resolveMailConfig } from '../emails/resolve-mail.ts';
import { guardEmail, guardMessage, type EmailGuardFail } from '../lib/email-guard.ts';

export type TrialLeadOutcome =
  | {
      ok: true;
      status: 'mailed' | 'resent' | 'has_license';
      email: string;
      /** Always returned so the site can offer a direct download when SMTP is off. */
      downloadUrl: string;
      mailPath?: string;
    }
  | {
      ok: false;
      error: 'invalid_email' | 'rate_limited';
      message?: string;
      retryAfterSec?: number;
    };

const RESEND_COOLDOWN_MS = 2 * 60 * 1000;
const RESEND_MAX_PER_DAY = 5;

async function downloadUrl(ctx: CoreContext, fallback: string): Promise<string> {
  const row = await selectOne<{ value: string }>(ctx.db, 'SELECT value FROM settings WHERE name = ?', ['download_url']);
  const value = row?.value?.trim();
  return value && value !== '' ? value : fallback;
}

async function hasActiveLicense(ctx: CoreContext, email: string, now: Date): Promise<boolean> {
  const row = await selectOne<{ id: number }>(
    ctx.db,
    `SELECT id FROM licenses
      WHERE email = ? AND status = 'active'
        AND (expires_at IS NULL OR expires_at > ?)
      LIMIT 1`,
    [email, now],
  );
  return row !== null;
}

/**
 * Create or refresh a trial lead and send the download email.
 * `resend` forces a new mail when a lead already exists (still rate-limited).
 */
export async function submitTrialLead(
  ctx: CoreContext,
  input: { email: string; ip: string | null; userAgent: string | null; resend?: boolean },
): Promise<TrialLeadOutcome> {
  const guarded = await guardEmail(input.email);
  if (!guarded.ok) {
    return { ok: false, error: 'invalid_email', message: guardMessage(guarded) };
  }
  const email = guarded.email;

  const mail = await resolveMailConfig(ctx);
  const now = ctx.clock.now();
  const link = await downloadUrl(ctx, mail.downloadUrl);

  if (await hasActiveLicense(ctx, email, now)) {
    return { ok: true, status: 'has_license', email, downloadUrl: link };
  }
  const ua = input.userAgent === null || input.userAgent === '' ? null : input.userAgent.slice(0, 512);

  const result = await withTransaction(ctx.db, async (tx) => {
    let lead = await selectOne<{
      id: number;
      status: string;
      download_sent_at: Date | null;
      resend_count: number;
    }>(tx, 'SELECT id, status, download_sent_at, resend_count FROM trial_leads WHERE email = ? FOR UPDATE', [
      email,
    ]);

    if (lead === null) {
      try {
        await write(
          tx,
          `INSERT INTO trial_leads
             (email, status, download_sent_at, resend_count, ip, user_agent, created_at, updated_at)
           VALUES (?, 'new', NULL, 0, ?, ?, ?, ?)`,
          [email, input.ip, ua, now, now],
        );
      } catch (err) {
        if (!isDuplicateKeyError(err)) throw err;
      }
      lead = await selectOne(tx, 'SELECT id, status, download_sent_at, resend_count FROM trial_leads WHERE email = ? FOR UPDATE', [
        email,
      ]);
      if (lead === null) throw new Error('trial_leads row missing after insert');
    }

    const isResend = lead.download_sent_at !== null;
    if (isResend || input.resend) {
      if (lead.download_sent_at !== null) {
        const elapsed = now.getTime() - lead.download_sent_at.getTime();
        if (elapsed < RESEND_COOLDOWN_MS) {
          return {
            ok: false as const,
            error: 'rate_limited' as const,
            retryAfterSec: Math.ceil((RESEND_COOLDOWN_MS - elapsed) / 1000),
          };
        }
      }
      if (lead.resend_count >= RESEND_MAX_PER_DAY && isResend) {
        return { ok: false as const, error: 'rate_limited' as const, retryAfterSec: 3600 };
      }
    }

    await write(
      tx,
      `UPDATE trial_leads
          SET status = 'mailed',
              download_sent_at = ?,
              resend_count = ?,
              ip = COALESCE(?, ip),
              user_agent = COALESCE(?, user_agent),
              updated_at = ?
        WHERE id = ?`,
      [now, isResend ? lead.resend_count + 1 : lead.resend_count, input.ip, ua, now, lead.id],
    );

    return { ok: true as const, isResend, leadId: lead.id };
  });

  if (!result.ok) {
    return { ok: false, error: result.error, retryAfterSec: result.retryAfterSec };
  }

  try {
    const sent = await sendTemplate(mail, 'trial_download', {
      email,
      downloadUrl: link,
      siteUrl: mail.siteUrl,
      pricingUrl: mail.pricingUrl,
      supportEmail: mail.supportEmail,
    });
    await logEmail(ctx.db, {
      to: email,
      template: 'trial_download',
      status: sent.mode === 'smtp' ? 'sent' : 'file',
      createdAt: now,
    });
    return {
      ok: true,
      status: result.isResend ? 'resent' : 'mailed',
      email,
      downloadUrl: link,
      mailPath: sent.path,
    };
  } catch (err) {
    await logEmail(ctx.db, {
      to: email,
      template: 'trial_download',
      status: 'failed',
      error: err instanceof Error ? err.message : String(err),
      createdAt: now,
    });
    throw err;
  }
}

export type { EmailGuardFail };
