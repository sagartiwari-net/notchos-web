import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import nodemailer from 'nodemailer';
import type { MailConfig } from './mail-config.ts';
import { getPreset, sampleVars } from './presets.ts';
import type { EmailTemplateId, EmailVars, RenderedEmail } from './types.ts';

export interface SendResult {
  mode: 'file' | 'smtp';
  template: EmailTemplateId;
  to: string;
  subject: string;
  path?: string;
  messageId?: string;
}

function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}

function safePart(value: string): string {
  return value.replace(/[^A-Za-z0-9._@+-]+/g, '_').slice(0, 80);
}

function mergeUrls(mail: MailConfig, vars: EmailVars): EmailVars {
  return {
    ...vars,
    siteUrl: vars.siteUrl ?? mail.siteUrl,
    downloadUrl: vars.downloadUrl ?? mail.downloadUrl,
    pricingUrl: vars.pricingUrl ?? mail.pricingUrl,
    supportEmail: vars.supportEmail ?? mail.supportEmail,
  };
}

export function renderTemplate(template: EmailTemplateId, vars: EmailVars, mail: MailConfig): RenderedEmail {
  return getPreset(template).render(mergeUrls(mail, vars));
}

export interface MailAttachment {
  filename: string;
  content: Buffer;
}

export async function sendTemplate(
  mail: MailConfig,
  template: EmailTemplateId,
  vars: EmailVars,
  attachment?: MailAttachment,
): Promise<SendResult> {
  const rendered = renderTemplate(template, vars, mail);
  const to = vars.email.trim();
  if (mail.mode === 'file' || mail.smtp === null) {
    mkdirSync(mail.dir, { recursive: true });
    const base = `${stamp()}-${template}-${safePart(to)}`;
    const htmlPath = join(mail.dir, `${base}.html`);
    const textPath = join(mail.dir, `${base}.txt`);
    writeFileSync(htmlPath, rendered.html, 'utf8');
    writeFileSync(textPath, rendered.text, 'utf8');
    if (attachment) {
      writeFileSync(join(mail.dir, `${base}-${attachment.filename}`), attachment.content);
    }
    return { mode: 'file', template, to, subject: rendered.subject, path: htmlPath };
  }

  const transport = nodemailer.createTransport({
    host: mail.smtp.host,
    port: mail.smtp.port,
    secure: mail.smtp.secure,
    auth: { user: mail.smtp.user, pass: mail.smtp.pass },
  });
  const info = await transport.sendMail({
    from: mail.from,
    to,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
    attachments: attachment
      ? [{ filename: attachment.filename, content: attachment.content, contentType: 'application/pdf' }]
      : undefined,
  });
  return {
    mode: 'smtp',
    template,
    to,
    subject: rendered.subject,
    messageId: info.messageId,
  };
}

export async function previewTemplate(
  mail: MailConfig,
  template: EmailTemplateId,
  to?: string,
): Promise<SendResult> {
  const vars = sampleVars(template, to);
  // Previews always write to disk so you can open them in a browser.
  return sendTemplate({ ...mail, mode: 'file', smtp: null }, template, vars);
}
