// Build MailConfig from admin Settings (DB) when present, else fall back to env.

import { homedir } from 'node:os';
import { join } from 'node:path';
import type { CoreContext } from '../context.ts';
import { selectOne } from '../db/pool.ts';
import type { MailConfig, MailMode } from './mail-config.ts';
import { parseMailConfig } from './mail-config.ts';

const SMTP_PASS_AAD = 'setting:mail_smtp_pass';

async function setting(ctx: CoreContext, name: string): Promise<string | null> {
  const row = await selectOne<{ value: string }>(ctx.db, 'SELECT value FROM settings WHERE name = ?', [name]);
  const value = row?.value?.trim();
  return value === undefined || value === '' ? null : value;
}

function envMailFallback(): MailConfig {
  try {
    return parseMailConfig();
  } catch {
    const siteUrl = process.env.SITE_URL?.trim() || 'https://notchos.app';
    return {
      mode: 'file',
      dir: process.env.MAIL_DIR?.trim() || join(homedir(), '.notchos-dev', 'mail'),
      from: process.env.MAIL_FROM?.trim() || 'NotchOS <noreply@notchos.app>',
      smtp: null,
      siteUrl,
      downloadUrl: process.env.DOWNLOAD_URL?.trim() || `${siteUrl}/download`,
      pricingUrl: process.env.PRICING_URL?.trim() || `${siteUrl}/#pricing`,
      supportEmail: process.env.SUPPORT_EMAIL?.trim() || 'support@notchos.app',
      logoUrl: process.env.MAIL_LOGO_URL?.trim() || null,
    };
  }
}

/** Prefer Settings saved in admin; env fills gaps (SITE_URL, MAIL_DIR, …). */
export async function resolveMailConfig(ctx: CoreContext): Promise<MailConfig> {
  const envMail = envMailFallback();
  const modeRaw = await setting(ctx, 'mail_mode');
  const mode: MailMode = modeRaw === 'smtp' ? 'smtp' : modeRaw === 'file' ? 'file' : envMail.mode;

  const user = (await setting(ctx, 'mail_smtp_user')) ?? envMail.smtp?.user ?? '';
  const host = (await setting(ctx, 'mail_smtp_host')) ?? envMail.smtp?.host ?? 'smtp.gmail.com';
  const portRaw = await setting(ctx, 'mail_smtp_port');
  const port = portRaw !== null && /^\d+$/.test(portRaw) ? Number(portRaw) : (envMail.smtp?.port ?? 465);
  const secureRaw = await setting(ctx, 'mail_smtp_secure');
  const secure = secureRaw === null ? (envMail.smtp?.secure ?? true) : secureRaw !== 'false';

  let pass = envMail.smtp?.pass ?? '';
  const encPass = await setting(ctx, 'mail_smtp_pass');
  if (encPass !== null) {
    try {
      pass = ctx.secretBox.decrypt(encPass, SMTP_PASS_AAD).toString('utf8');
    } catch {
      pass = '';
    }
  }

  const mailFrom = (await setting(ctx, 'mail_from')) ?? null;
  const support = (await setting(ctx, 'mail_support_email')) ?? envMail.supportEmail;
  const download = (await setting(ctx, 'download_url')) ?? envMail.downloadUrl;

  if (mode === 'smtp' && user !== '' && pass !== '') {
    return {
      mode: 'smtp',
      dir: envMail.dir,
      from: mailFrom && mailFrom.includes('@') ? mailFrom : mailFrom ? `${mailFrom} <${user}>` : `NotchOS <${user}>`,
      smtp: { host, port, secure, user, pass },
      siteUrl: envMail.siteUrl,
      downloadUrl: download,
      pricingUrl: envMail.pricingUrl,
      supportEmail: support,
      logoUrl: envMail.logoUrl,
    };
  }

  return {
    ...envMail,
    mode: 'file',
    dir: envMail.dir || join('/www/server/notchos/mail'),
    downloadUrl: download,
    supportEmail: support,
    from: mailFrom && mailFrom.includes('@') ? mailFrom : envMail.from,
    smtp: null,
  };
}
