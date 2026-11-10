// GET /settings, PUT /settings
//
// The settings table holds one text value per name. The three numbers (trial_days,
// transfer_limit, renewal_buffer_hours) and download_url are read by the license code and
// the emails already; the rest is added here:
//
//   price_monthly, price_lifetime, app_version, paypal_plan_id (read-only here)
//   mail_mode, mail_smtp_host, mail_smtp_port, mail_smtp_secure, mail_smtp_user,
//   mail_smtp_pass (encrypted with KEY_ENC_SECRET, never returned), mail_from, mail_support_email
//
// A null value is stored as "no row".

import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.ts';
import type { Queryable } from '../db/pool.ts';
import { selectRows, withTransaction, write } from '../db/pool.ts';
import { sendOk } from '../http/respond.ts';
import { getNumericSetting, SETTING_RANGE } from '../services/settings.ts';
import type { NumericSetting } from '../services/settings.ts';
import { writeAudit } from './audit.ts';
import {
  bodyObject,
  invalid,
  readEmail,
  readHttpsUrl,
  readInt,
  readPrice,
  readVersion,
  routeHandler,
} from './http.ts';

type MailMode = 'file' | 'smtp';

interface MailSettings {
  mode: MailMode;
  smtp_host: string;
  smtp_port: number;
  smtp_secure: boolean;
  smtp_user: string | null;
  smtp_pass_set: boolean;
  mail_from: string | null;
  support_email: string | null;
}

interface Settings {
  prices: { monthly: string | null; lifetime: string | null };
  trial_days: number;
  transfer_limit: number;
  renewal_buffer_hours: number;
  download_url: string | null;
  app_version: string | null;
  paypal_plan_id: string | null;
  mail: MailSettings;
}

const SMTP_PASS_AAD = 'setting:mail_smtp_pass';

function textOrNull(values: Map<string, string>, name: string): string | null {
  const value = values.get(name)?.trim();
  return value === undefined || value === '' ? null : value;
}

export async function readSettings(q: Queryable): Promise<Settings> {
  const rows = await selectRows<{ name: string; value: string }>(q, 'SELECT name, value FROM settings');
  const values = new Map(rows.map((row) => [row.name, row.value]));
  const port = Number(values.get('mail_smtp_port'));
  return {
    prices: { monthly: textOrNull(values, 'price_monthly'), lifetime: textOrNull(values, 'price_lifetime') },
    trial_days: await getNumericSetting(q, 'trial_days'),
    transfer_limit: await getNumericSetting(q, 'transfer_limit'),
    renewal_buffer_hours: await getNumericSetting(q, 'renewal_buffer_hours'),
    download_url: textOrNull(values, 'download_url'),
    app_version: textOrNull(values, 'app_version'),
    paypal_plan_id: textOrNull(values, 'paypal_plan_id'),
    mail: {
      mode: values.get('mail_mode') === 'smtp' ? 'smtp' : 'file',
      smtp_host: textOrNull(values, 'mail_smtp_host') ?? 'smtp.gmail.com',
      smtp_port: Number.isInteger(port) && port >= 1 && port <= 65535 ? port : 465,
      smtp_secure: values.get('mail_smtp_secure') !== 'false',
      smtp_user: textOrNull(values, 'mail_smtp_user'),
      smtp_pass_set: textOrNull(values, 'mail_smtp_pass') !== null,
      mail_from: textOrNull(values, 'mail_from'),
      support_email: textOrNull(values, 'mail_support_email'),
    },
  };
}

type PassChange = { kind: 'keep' } | { kind: 'clear' } | { kind: 'set'; value: string };

function readMailUpdate(raw: unknown, current: MailSettings, fields: Record<string, string>) {
  const body = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const changes: string[] = [];

  let mode = current.mode;
  if (body.mode === 'file' || body.mode === 'smtp') mode = body.mode;
  else if (body.mode !== undefined) fields['mail.mode'] = 'Choose file (local preview) or smtp (Gmail).';

  let smtpHost = current.smtp_host;
  if (typeof body.smtp_host === 'string' && body.smtp_host.trim() !== '' && body.smtp_host.trim().length <= 253) {
    smtpHost = body.smtp_host.trim();
  } else if (body.smtp_host !== undefined && body.smtp_host !== null) {
    fields['mail.smtp_host'] = 'Enter an SMTP host, for example smtp.gmail.com.';
  }

  let smtpPort = current.smtp_port;
  if (body.smtp_port !== undefined) {
    const port = readInt(body.smtp_port, 1, 65535);
    if (port === null) fields['mail.smtp_port'] = 'Enter a port from 1 to 65535 (Gmail uses 465).';
    else smtpPort = port;
  }

  let smtpSecure = current.smtp_secure;
  if (typeof body.smtp_secure === 'boolean') smtpSecure = body.smtp_secure;

  let smtpUser = current.smtp_user;
  if (body.smtp_user === null || body.smtp_user === '') {
    smtpUser = null;
  } else if (typeof body.smtp_user === 'string') {
    const email = readEmail(body.smtp_user);
    if (email === null) fields['mail.smtp_user'] = 'Enter the Gmail address used to sign in to SMTP.';
    else smtpUser = email;
  }

  let pass: PassChange = { kind: 'keep' };
  if (Object.prototype.hasOwnProperty.call(body, 'smtp_pass')) {
    if (body.smtp_pass === null || body.smtp_pass === '') {
      pass = { kind: 'clear' };
    } else if (typeof body.smtp_pass === 'string') {
      if (body.smtp_pass.length < 8 || body.smtp_pass.length > 200) {
        fields['mail.smtp_pass'] = 'Enter a Gmail app password (at least 8 characters).';
      } else {
        pass = { kind: 'set', value: body.smtp_pass };
      }
    } else {
      fields['mail.smtp_pass'] = 'Enter a Gmail app password, or leave blank to keep the current one.';
    }
  }

  let mailFrom = current.mail_from;
  if (body.mail_from === null || body.mail_from === '') {
    mailFrom = null;
  } else if (typeof body.mail_from === 'string') {
    const trimmed = body.mail_from.trim();
    if (trimmed.length > 200) fields['mail.mail_from'] = 'Keep the From line under 200 characters.';
    else mailFrom = trimmed;
  }

  let supportEmail = current.support_email;
  if (body.support_email === null || body.support_email === '') {
    supportEmail = null;
  } else if (typeof body.support_email === 'string') {
    const email = readEmail(body.support_email);
    if (email === null) fields['mail.support_email'] = 'Enter a valid support email, or leave it empty.';
    else supportEmail = email;
  }

  const passSetAfter = pass.kind === 'keep' ? current.smtp_pass_set : pass.kind === 'set';
  if (mode === 'smtp' && smtpUser === null) fields['mail.smtp_user'] = 'SMTP mode needs a Gmail address.';
  if (mode === 'smtp' && !passSetAfter) fields['mail.smtp_pass'] = 'SMTP mode needs a Gmail app password.';

  const next: MailSettings = {
    mode,
    smtp_host: smtpHost,
    smtp_port: smtpPort,
    smtp_secure: smtpSecure,
    smtp_user: smtpUser,
    smtp_pass_set: passSetAfter,
    mail_from: mailFrom,
    support_email: supportEmail,
  };
  const show = (value: string | number | boolean | null) => (value === null ? 'not set' : String(value));
  for (const key of ['mode', 'smtp_host', 'smtp_port', 'smtp_secure', 'smtp_user', 'mail_from', 'support_email'] as const) {
    if (current[key] !== next[key]) changes.push(`mail.${key}: ${show(current[key])} → ${show(next[key])}`);
  }
  if (pass.kind === 'set') changes.push('mail.smtp_pass: updated');
  if (pass.kind === 'clear' && current.smtp_pass_set) changes.push('mail.smtp_pass: cleared');
  return { next, pass, changes };
}

async function putSetting(q: Queryable, name: string, value: string | number | boolean | null): Promise<void> {
  if (value === null) {
    await write(q, 'DELETE FROM settings WHERE name = ?', [name]);
  } else {
    await write(q, 'INSERT INTO settings (name, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value)', [
      name,
      String(value),
    ]);
  }
}

export function registerSettingsRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { clock, db } = ctx;

  app.get(
    '/settings',
    routeHandler(clock, async (_request, reply) => sendOk(reply, clock, { ...(await readSettings(db)) })),
  );

  app.put(
    '/settings',
    routeHandler(clock, async (request, reply) => {
      const body = bodyObject(request);
      const prices = typeof body.prices === 'object' && body.prices !== null ? (body.prices as Record<string, unknown>) : {};
      const fields: Record<string, string> = {};

      // A value that may be unset: null clears it, anything else must pass `read`.
      const optional = (value: unknown, read: (value: unknown) => string | null, name: string, message: string) => {
        if (value === null) return null;
        const result = read(value);
        if (result === null) fields[name] = message;
        return result;
      };
      const numeric = (name: NumericSetting, unit: string): number => {
        const { min, max } = SETTING_RANGE[name];
        const result = readInt(body[name], min, max);
        if (result === null) fields[name] = `Enter a whole number of ${unit} from ${min} to ${max}.`;
        return result ?? min;
      };

      const now = clock.now();
      const before = await readSettings(db);
      const mail = readMailUpdate(body.mail, before.mail, fields);
      const next = {
        price_monthly: optional(prices.monthly, readPrice, 'prices.monthly', 'Enter a price above zero, for example 4.99.'),
        price_lifetime: optional(prices.lifetime, readPrice, 'prices.lifetime', 'Enter a price above zero, for example 29.99.'),
        trial_days: numeric('trial_days', 'days'),
        transfer_limit: numeric('transfer_limit', 'moves'),
        renewal_buffer_hours: numeric('renewal_buffer_hours', 'hours'),
        download_url: optional(body.download_url, readHttpsUrl, 'download_url', 'Enter a link that starts with https://'),
        app_version: optional(body.app_version, readVersion, 'app_version', 'Enter a version such as 0.7.0.'),
      };
      if (Object.keys(fields).length > 0) invalid(fields);

      const show = (value: string | number | null) => (value === null ? 'not set' : String(value));
      const pairs: Array<[string, string | number | null, string | number | null]> = [
        ['prices.monthly', before.prices.monthly, next.price_monthly],
        ['prices.lifetime', before.prices.lifetime, next.price_lifetime],
        ['trial_days', before.trial_days, next.trial_days],
        ['transfer_limit', before.transfer_limit, next.transfer_limit],
        ['renewal_buffer_hours', before.renewal_buffer_hours, next.renewal_buffer_hours],
        ['download_url', before.download_url, next.download_url],
        ['app_version', before.app_version, next.app_version],
      ];
      const changes = [
        ...pairs.filter(([, from, to]) => from !== to).map(([name, from, to]) => `${name}: ${show(from)} → ${show(to)}`),
        ...mail.changes,
      ];

      await withTransaction(db, async (tx) => {
        await putSetting(tx, 'price_monthly', next.price_monthly);
        await putSetting(tx, 'price_lifetime', next.price_lifetime);
        await putSetting(tx, 'trial_days', next.trial_days);
        await putSetting(tx, 'transfer_limit', next.transfer_limit);
        await putSetting(tx, 'renewal_buffer_hours', next.renewal_buffer_hours);
        await putSetting(tx, 'download_url', next.download_url);
        await putSetting(tx, 'app_version', next.app_version);
        await putSetting(tx, 'mail_mode', mail.next.mode);
        await putSetting(tx, 'mail_smtp_host', mail.next.smtp_host);
        await putSetting(tx, 'mail_smtp_port', mail.next.smtp_port);
        await putSetting(tx, 'mail_smtp_secure', mail.next.smtp_secure);
        await putSetting(tx, 'mail_smtp_user', mail.next.smtp_user);
        await putSetting(tx, 'mail_from', mail.next.mail_from);
        await putSetting(tx, 'mail_support_email', mail.next.support_email);
        if (mail.pass.kind === 'set') {
          await putSetting(tx, 'mail_smtp_pass', ctx.secretBox.encrypt(mail.pass.value, SMTP_PASS_AAD));
        } else if (mail.pass.kind === 'clear') {
          await putSetting(tx, 'mail_smtp_pass', null);
        }
        await writeAudit(tx, {
          adminId: request.admin!.id,
          action: 'settings.update',
          target: 'settings',
          detail: changes.length === 0 ? 'no changes' : changes.join('; '),
          ip: request.ip,
          at: now,
        });
      });

      return sendOk(reply, clock, { ...(await readSettings(db)) });
    }),
  );
}
