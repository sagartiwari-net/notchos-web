/**
 * Mail settings are separate from the full API Config so `email:preview` can run
 * without a database.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { ConfigError, type EnvValues, readEnv } from '../config.ts';

export type MailMode = 'file' | 'smtp';

export interface MailConfig {
  mode: MailMode;
  dir: string;
  from: string;
  smtp: {
    host: string;
    port: number;
    secure: boolean;
    user: string;
    pass: string;
  } | null;
  siteUrl: string;
  downloadUrl: string;
  pricingUrl: string;
  supportEmail: string;
  logoUrl: string | null;
}

function optional(values: EnvValues, name: string): string | undefined {
  const value = values[name];
  return value === undefined || value.trim() === '' ? undefined : value.trim();
}

export function parseMailConfig(values: EnvValues = process.env): MailConfig {
  const env = readEnv(values);
  const user = optional(env, 'SMTP_USER') ?? '';
  const pass = optional(env, 'SMTP_PASS') ?? '';
  const modeRaw = optional(env, 'MAIL_MODE');
  let mode: MailMode;
  if (modeRaw === 'smtp' || modeRaw === 'file') {
    mode = modeRaw;
  } else {
    mode = user !== '' && pass !== '' ? 'smtp' : 'file';
  }
  if (mode === 'smtp' && (user === '' || pass === '')) {
    throw new ConfigError('MAIL_MODE=smtp requires SMTP_USER and SMTP_PASS (Gmail app password)');
  }

  const siteUrl = optional(env, 'SITE_URL') ?? 'http://127.0.0.1:4312';
  const from = optional(env, 'MAIL_FROM') ?? (user !== '' ? `NotchOS <${user}>` : 'NotchOS <noreply@notchos.app>');

  return {
    mode,
    dir: optional(env, 'MAIL_DIR') ?? join(homedir(), '.notchos-dev', 'mail'),
    from,
    smtp:
      mode === 'smtp'
        ? {
            host: optional(env, 'SMTP_HOST') ?? 'smtp.gmail.com',
            port: Number(optional(env, 'SMTP_PORT') ?? '465'),
            secure: (optional(env, 'SMTP_SECURE') ?? 'true') !== 'false',
            user,
            pass,
          }
        : null,
    siteUrl,
    downloadUrl: optional(env, 'DOWNLOAD_URL') ?? `${siteUrl}/download`,
    pricingUrl: optional(env, 'PRICING_URL') ?? `${siteUrl}/#pricing`,
    supportEmail: optional(env, 'SUPPORT_EMAIL') ?? 'support@notchos.app',
    logoUrl: optional(env, 'MAIL_LOGO_URL') ?? null,
  };
}
