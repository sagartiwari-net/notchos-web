// Website trial leads: email capture + download mail. Does not start a device trial.
// See NOTCHOS-TRIAL-SEAT-PLAN.md.

import type { Db } from '../db/pool.ts';
import { isDuplicateKeyError, selectOne, withTransaction, write } from '../db/pool.ts';
import { parseMailConfig } from '../emails/mail-config.ts';
import { sendTemplate } from '../emails/mailer.ts';
import { guardEmail, guardMessage, type EmailGuardFail } from '../lib/email-guard.ts';
import type { Clock } from '../lib/time.ts';

export interface TrialLeadDeps {
  db: Db;
  clock: Clock;
}

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

async function downloadUrl(db: Db, fallback: string): Promise<string> {
  const row = await selectOne<{ value: string }>(db, 'SELECT value FROM settings WHERE name = ?', ['download_url']);
  const value = row?.value?.trim();
  return value && value !== '' ? value : fallback;
}

async function hasActiveLicense(db: Db, email: string, now: Date): Promise<boolean> {
  const row = await selectOne<{ id: number }>(
    db,
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
  deps: TrialLeadDeps,
  input: { email: string; ip: string | null; userAgent: string | null; resend?: boolean },
): Promise<TrialLeadOutcome> {
  const guarded = await guardEmail(input.email);
  if (!guarded.ok) {
    return { ok: false, error: 'invalid_email', message: guardMessage(guarded) };
  }
  const email = guarded.email;

  const mail = parseMailConfig();
  const now = deps.clock.now();
  const link = await downloadUrl(deps.db, mail.downloadUrl);

  if (await hasActiveLicense(deps.db, email, now)) {
    return { ok: true, status: 'has_license', email, downloadUrl: link };
  }
  const ua = input.userAgent === null || input.userAgent === '' ? null : input.userAgent.slice(0, 512);

  const result = await withTransaction(deps.db, async (tx) => {
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

  const sent = await sendTemplate(mail, 'trial_download', {
    email,
    downloadUrl: link,
    siteUrl: mail.siteUrl,
    pricingUrl: mail.pricingUrl,
    supportEmail: mail.supportEmail,
  });

  return {
    ok: true,
    status: result.isResend ? 'resent' : 'mailed',
    email,
    downloadUrl: link,
    mailPath: sent.path,
  };
}

export type { EmailGuardFail };
