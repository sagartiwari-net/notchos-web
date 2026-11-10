import { bulletList, codeBlock, paragraphs, renderLayout, textVersion } from './layout.ts';
import type { EmailPreset, EmailTemplateId, EmailVars, RenderedEmail } from './types.ts';

function greet(vars: EmailVars): string {
  const name = vars.name?.trim();
  return name ? `Hi ${name},` : 'Hi,';
}

function urls(vars: EmailVars) {
  const siteUrl = vars.siteUrl ?? 'https://notchos.app';
  return {
    siteUrl,
    downloadUrl: vars.downloadUrl ?? `${siteUrl}/download`,
    pricingUrl: vars.pricingUrl ?? `${siteUrl}/#pricing`,
    supportEmail: vars.supportEmail ?? 'support@notchos.app',
  };
}

function activateSteps(email: string, key?: string): string {
  const keyLine = key
    ? `Your license key is below. In NotchOS, open <strong>Activate</strong> and paste this PayPal email (<strong>${email}</strong>) plus the key.`
    : `In NotchOS, open <strong>Activate</strong> and paste the PayPal email that received this message, plus your license key.`;
  return paragraphs([
    keyLine,
    'Both must match on the server. After that, Pro unlocks on this Mac.',
  ]);
}

function withDefaults(vars: EmailVars): EmailVars {
  return {
    ...vars,
    email: vars.email.trim(),
  };
}

const trial_download: EmailPreset = {
  id: 'trial_download',
  summary: 'Website trial lead — DMG download + how to start trial in the app',
  render(raw): RenderedEmail {
    const vars = withDefaults(raw);
    const { downloadUrl, pricingUrl, siteUrl, supportEmail } = urls(vars);
    const title = 'Download NotchOS and start your free trial';
    const bodyHtml =
      paragraphs([
        greet(vars),
        'Thanks for trying <strong>NotchOS</strong>. Download the Mac app with the button below, then start the 7-day trial inside the app — no card.',
        'The trial is locked to that Mac. Reinstalling does not start a new one. When you buy later, your key arrives at your PayPal email.',
      ]) +
      bulletList([
        'Open the DMG and drag NotchOS to Applications',
        'Launch NotchOS → Start free trial (needs internet once)',
        'On Sequoia+, if Gatekeeper blocks the first open: System Settings → Privacy & Security → Open Anyway',
      ]);
    return {
      subject: 'Your NotchOS download link',
      html: renderLayout({
        title,
        preheader: 'Download NotchOS, then start the 7-day trial in the app.',
        bodyHtml,
        cta: { label: 'Download NotchOS', href: downloadUrl },
        secondaryCta: { label: 'See pricing', href: pricingUrl },
        footerNote: `Questions? ${supportEmail}. You asked for a trial download on the NotchOS site.`,
        siteUrl,
      }),
      text: textVersion([
        title,
        greet(vars),
        'Download NotchOS, install it, then Start free trial in the app. No card.',
        `Download: ${downloadUrl}`,
        `Pricing: ${pricingUrl}`,
      ]),
    };
  },
};

const trial_started: EmailPreset = {
  id: 'trial_started',
  summary: 'Trial started on a Mac (no key)',
  render(raw): RenderedEmail {
    const vars = withDefaults(raw);
    const { downloadUrl, pricingUrl, siteUrl } = urls(vars);
    const ends = vars.expiresAt ?? 'in 7 days';
    const title = 'Your NotchOS trial is on';
    const bodyHtml =
      paragraphs([
        greet(vars),
        `Your 7-day free trial is active on this Mac${vars.deviceName ? ` (<strong>${vars.deviceName}</strong>)` : ''}. It ends <strong>${ends}</strong>.`,
        'Until then, Core faces and Pro tools are unlocked — Tray, Clipboard, Calendar, Tasks, Timers, Prompter, Writing Tools, and the rest.',
        'No card was charged. When the trial ends, buy Monthly or Lifetime to keep going. One key unlocks one Mac.',
      ]) +
      bulletList([
        'Trial is tied to this Mac — reinstalling does not start a new one',
        'Buy anytime; your key arrives at your PayPal email',
        'Activate in the app with that email + key',
      ]);
    return {
      subject: 'NotchOS trial started — ends ' + ends,
      html: renderLayout({
        title,
        preheader: `Trial active until ${ends}. Buy before it ends to keep Pro.`,
        bodyHtml,
        cta: { label: 'See pricing', href: pricingUrl },
        secondaryCta: { label: 'Download NotchOS', href: downloadUrl },
        footerNote: 'You are receiving this because a trial was started for this address or device from support.',
        siteUrl,
      }),
      text: textVersion([
        title,
        greet(vars),
        `Your free trial is active${vars.deviceName ? ` on ${vars.deviceName}` : ''}. It ends ${ends}.`,
        'Buy Monthly or Lifetime before it ends to keep Pro unlocked.',
        `Pricing: ${pricingUrl}`,
        `Download: ${downloadUrl}`,
      ]),
    };
  },
};

const purchase_monthly: EmailPreset = {
  id: 'purchase_monthly',
  summary: 'Monthly purchase — key email',
  render(raw): RenderedEmail {
    const vars = withDefaults(raw);
    const { downloadUrl, pricingUrl, siteUrl, supportEmail } = urls(vars);
    const key = vars.key ?? 'NOS-XXXXX-XXXXX-XXXXX-XXXXX';
    const title = 'Your NotchOS Monthly key';
    const bodyHtml =
      paragraphs([
        greet(vars),
        'Thanks for buying <strong>NotchOS Monthly</strong>. Your license key is below. It belongs to this PayPal email — keep this message.',
      ]) +
      codeBlock(key) +
      activateSteps(vars.email, key) +
      bulletList([
        'One key, one Mac at a time (transfers available if you change machines)',
        'Renewal is handled by PayPal Automatic payments',
        'Cancel anytime in PayPal → Automatic payments; NotchOS stays active until the period you paid for ends',
        vars.expiresAt ? `Current period ends <strong>${vars.expiresAt}</strong>` : 'Your period dates are in PayPal and in the app after activate',
      ]);
    return {
      subject: 'Your NotchOS Monthly license key',
      html: renderLayout({
        title,
        preheader: 'Your key is inside. Activate with this PayPal email in NotchOS.',
        bodyHtml,
        cta: { label: 'Download NotchOS', href: downloadUrl },
        secondaryCta: { label: 'How pricing works', href: pricingUrl },
        footerNote: `Questions? ${supportEmail}. Never share your key publicly.`,
        siteUrl,
      }),
      text: textVersion([
        title,
        greet(vars),
        `Key: ${key}`,
        `Activate in NotchOS with email ${vars.email} and this key.`,
        'Cancel monthly in PayPal → Automatic payments.',
        `Download: ${downloadUrl}`,
      ]),
    };
  },
};

const purchase_lifetime: EmailPreset = {
  id: 'purchase_lifetime',
  summary: 'Lifetime purchase — key email',
  render(raw): RenderedEmail {
    const vars = withDefaults(raw);
    const { downloadUrl, pricingUrl, siteUrl, supportEmail } = urls(vars);
    const key = vars.key ?? 'NOS-XXXXX-XXXXX-XXXXX-XXXXX';
    const title = 'Your NotchOS Lifetime key';
    const bodyHtml =
      paragraphs([
        greet(vars),
        'Thanks for buying <strong>NotchOS Lifetime</strong>. Pay once — this key does not expire. It belongs to this PayPal email.',
      ]) +
      codeBlock(key) +
      activateSteps(vars.email, key) +
      bulletList([
        'One Mac at a time; you can move the seat with a transfer or free it from support',
        'Updates for this major line are included',
        'Lost key? Use Recover on the site with this same PayPal email',
      ]);
    return {
      subject: 'Your NotchOS Lifetime license key',
      html: renderLayout({
        title,
        preheader: 'Lifetime key inside. Activate once — it does not expire.',
        bodyHtml,
        cta: { label: 'Download NotchOS', href: downloadUrl },
        secondaryCta: { label: 'Recover a lost key', href: `${siteUrl}/recover` },
        footerNote: `Questions? ${supportEmail}.`,
        siteUrl,
      }),
      text: textVersion([
        title,
        greet(vars),
        `Key: ${key}`,
        `Activate with ${vars.email} + this key. Lifetime — no expiry.`,
        `Download: ${downloadUrl}`,
      ]),
    };
  },
};

const key_resend: EmailPreset = {
  id: 'key_resend',
  summary: 'Resend existing key to PayPal email',
  render(raw): RenderedEmail {
    const vars = withDefaults(raw);
    const { downloadUrl, siteUrl, supportEmail } = urls(vars);
    const key = vars.key ?? 'NOS-XXXXX-XXXXX-XXXXX-XXXXX';
    const planLabel = vars.plan === 'lifetime' ? 'Lifetime' : vars.plan === 'monthly' ? 'Monthly' : 'NotchOS';
    const title = 'Your NotchOS key again';
    const bodyHtml =
      paragraphs([
        greet(vars),
        `Here is your <strong>${planLabel}</strong> license key again. It is still tied to this PayPal email.`,
      ]) +
      codeBlock(key) +
      activateSteps(vars.email, key) +
      paragraphs([
        'If you did not ask for this resend, you can ignore this message — the key was not changed. For a stolen Mac, free the seat from support.',
      ]);
    return {
      subject: 'Your NotchOS license key (resend)',
      html: renderLayout({
        title,
        preheader: 'Resent key — same email + key to activate.',
        bodyHtml,
        cta: { label: 'Download NotchOS', href: downloadUrl },
        secondaryCta: { label: 'Recover page', href: `${siteUrl}/recover` },
        footerNote: `Sent only to the license email on file. ${supportEmail}`,
        siteUrl,
      }),
      text: textVersion([
        title,
        `Key: ${key}`,
        `Activate with ${vars.email} + key.`,
        `Download: ${downloadUrl}`,
      ]),
    };
  },
};

const license_expired: EmailPreset = {
  id: 'license_expired',
  summary: 'Monthly license expired — features locked',
  render(raw): RenderedEmail {
    const vars = withDefaults(raw);
    const { pricingUrl, downloadUrl, siteUrl } = urls(vars);
    const title = 'Your NotchOS Monthly plan ended';
    const bodyHtml = paragraphs([
      greet(vars),
      `Your Monthly period${vars.expiresAt ? ` ended on <strong>${vars.expiresAt}</strong>` : ' has ended'}. NotchOS on that Mac is locked until you renew or switch to Lifetime.`,
      'Nothing is wrong with your Mac — only the paid period ran out. Renew with PayPal, or buy Lifetime once.',
      'Your old key still works after a new payment on the same PayPal email (or we send a fresh key if you buy again).',
    ]);
    return {
      subject: 'NotchOS Monthly expired — renew to unlock',
      html: renderLayout({
        title,
        preheader: 'Monthly ended. Renew or buy Lifetime to unlock again.',
        bodyHtml,
        cta: { label: 'Renew or buy', href: pricingUrl },
        secondaryCta: { label: 'Open download', href: downloadUrl },
        siteUrl,
      }),
      text: textVersion([
        title,
        greet(vars),
        `Monthly ended${vars.expiresAt ? ` on ${vars.expiresAt}` : ''}. Renew or buy Lifetime: ${pricingUrl}`,
      ]),
    };
  },
};

const license_expiring: EmailPreset = {
  id: 'license_expiring',
  summary: 'Monthly ending soon — renew reminder',
  render(raw): RenderedEmail {
    const vars = withDefaults(raw);
    const { pricingUrl, siteUrl } = urls(vars);
    const days = vars.daysLeft ?? 3;
    const title = `NotchOS Monthly ends in ${days} day${days === 1 ? '' : 's'}`;
    const bodyHtml = paragraphs([
      greet(vars),
      `Your Monthly plan${vars.expiresAt ? ` ends on <strong>${vars.expiresAt}</strong>` : ' is ending soon'}. If PayPal auto-renew is on, you usually do not need to do anything.`,
      'If you cancelled Automatic payments, renew before the end date to avoid a lock, or switch to Lifetime.',
    ]);
    return {
      subject: `NotchOS: ${days} day${days === 1 ? '' : 's'} left on Monthly`,
      html: renderLayout({
        title,
        preheader: 'Renew reminder so Pro stays unlocked.',
        bodyHtml,
        cta: { label: 'View plans', href: pricingUrl },
        siteUrl,
      }),
      text: textVersion([title, greet(vars), `Plans: ${pricingUrl}`]),
    };
  },
};

const multiple_device: EmailPreset = {
  id: 'multiple_device',
  summary: 'Seat full — another Mac tried this key',
  render(raw): RenderedEmail {
    const vars = withDefaults(raw);
    const { siteUrl, supportEmail } = urls(vars);
    const device = vars.deviceName ?? 'another Mac';
    const title = 'A second Mac tried your NotchOS key';
    const bodyHtml =
      paragraphs([
        greet(vars),
        `Someone tried to activate your key on <strong>${device}</strong>, but this license already has its Mac seat in use.`,
        'NotchOS keys are one Mac at a time. The new Mac was not activated.',
      ]) +
      bulletList([
        'If this was you: free the old seat in Settings after uninstall, use a transfer, or ask support to free the seat',
        'If this was not you: change your PayPal password and contact support — do not forward the key email',
        'You never need to type the key into a website except Recover (which only resends to this address)',
      ]);
    return {
      subject: 'NotchOS: activation blocked — seat already in use',
      html: renderLayout({
        title,
        preheader: `${device} tried your key. Seat was not moved.`,
        bodyHtml,
        cta: { label: 'Recover / help', href: `${siteUrl}/recover` },
        footerNote: `Security note sent to ${vars.email}. ${supportEmail}`,
        siteUrl,
      }),
      text: textVersion([
        title,
        `${device} tried to activate; seat full.`,
        `Help: ${siteUrl}/recover · ${supportEmail}`,
      ]),
    };
  },
};

const license_revoked: EmailPreset = {
  id: 'license_revoked',
  summary: 'License revoked (refund or admin)',
  render(raw): RenderedEmail {
    const vars = withDefaults(raw);
    const { pricingUrl, siteUrl, supportEmail } = urls(vars);
    const title = 'Your NotchOS license was revoked';
    const bodyHtml = paragraphs([
      greet(vars),
      'This license is no longer active. NotchOS on the linked Mac will lock on the next check.',
      'That usually happens after a PayPal refund or a support action. If you did not expect this, reply or write to support with your PayPal email — we can look up the payment.',
    ]);
    return {
      subject: 'NotchOS license revoked',
      html: renderLayout({
        title,
        preheader: 'This key no longer unlocks NotchOS.',
        bodyHtml,
        cta: { label: 'Buy again', href: pricingUrl },
        footerNote: supportEmail,
        siteUrl,
      }),
      text: textVersion([title, greet(vars), `Support: ${supportEmail}`, `Buy: ${pricingUrl}`]),
    };
  },
};

const promo_buy: EmailPreset = {
  id: 'promo_buy',
  summary: 'Promote Monthly / Lifetime purchase',
  render(raw): RenderedEmail {
    const vars = withDefaults(raw);
    const { pricingUrl, downloadUrl, siteUrl } = urls(vars);
    const title = vars.promoHeadline?.trim() || 'Put your Mac’s notch to work';
    const body =
      vars.promoBody?.trim() ||
      'NotchOS turns the notch into a glass island for files, clipboard history, calendar, tasks, timers, a teleprompter and system stats. Start a 7-day trial in the app — no card — or buy Monthly / Lifetime when you are ready.';
    const bodyHtml =
      paragraphs([greet(vars), body]) +
      bulletList([
        '7-day in-app trial, no card',
        'One key, one Mac',
        'Key emailed to your PayPal address after purchase',
      ]);
    return {
      subject: 'NotchOS — trial free, then Monthly or Lifetime',
      html: renderLayout({
        title,
        preheader: 'Try free for 7 days. Buy when it sticks.',
        bodyHtml,
        cta: { label: 'See pricing', href: pricingUrl },
        secondaryCta: { label: 'Download free trial', href: downloadUrl },
        siteUrl,
      }),
      text: textVersion([title, body, `Pricing: ${pricingUrl}`, `Download: ${downloadUrl}`]),
    };
  },
};

const promo_trial_ending: EmailPreset = {
  id: 'promo_trial_ending',
  summary: 'Trial ending soon — buy to keep Pro',
  render(raw): RenderedEmail {
    const vars = withDefaults(raw);
    const { pricingUrl, siteUrl } = urls(vars);
    const days = vars.daysLeft ?? 2;
    const title = `Trial ends in ${days} day${days === 1 ? '' : 's'}`;
    const bodyHtml = paragraphs([
      greet(vars),
      `Your NotchOS trial${vars.expiresAt ? ` ends on <strong>${vars.expiresAt}</strong>` : ' is almost over'}. After that, the app locks until you activate a paid key.`,
      'Monthly keeps you flexible. Lifetime is one payment. Either way the key arrives at your PayPal email — paste email + key in Activate.',
    ]);
    return {
      subject: `NotchOS trial ends in ${days} day${days === 1 ? '' : 's'}`,
      html: renderLayout({
        title,
        preheader: 'Buy Monthly or Lifetime to keep Pro unlocked.',
        bodyHtml,
        cta: { label: 'Buy NotchOS', href: pricingUrl },
        siteUrl,
      }),
      text: textVersion([title, `Buy: ${pricingUrl}`]),
    };
  },
};

export const EMAIL_PRESETS: Record<EmailTemplateId, EmailPreset> = {
  trial_started,
  trial_download,
  purchase_monthly,
  purchase_lifetime,
  key_resend,
  license_expired,
  license_expiring,
  multiple_device,
  license_revoked,
  promo_buy,
  promo_trial_ending,
};

export const EMAIL_TEMPLATE_IDS = Object.keys(EMAIL_PRESETS) as EmailTemplateId[];

export function getPreset(id: string): EmailPreset {
  const preset = EMAIL_PRESETS[id as EmailTemplateId];
  if (preset === undefined) {
    throw new Error(`Unknown email template: ${id}. Known: ${EMAIL_TEMPLATE_IDS.join(', ')}`);
  }
  return preset;
}

/** Sample vars for CLI previews. */
export function sampleVars(template: EmailTemplateId, to?: string): EmailVars {
  const email = to ?? 'buyer@example.com';
  const base: EmailVars = {
    name: 'Alex',
    email,
    siteUrl: 'http://127.0.0.1:4312',
    downloadUrl: 'http://127.0.0.1:4312/download',
    pricingUrl: 'http://127.0.0.1:4312/#pricing',
    supportEmail: 'support@notchos.app',
    deviceName: 'Alex’s MacBook Pro',
    expiresAt: '17 Nov 2026',
    daysLeft: 2,
    key: 'NOS-7K3MQ-9PL2R-4XHW8-TJ6VN',
  };
  switch (template) {
    case 'purchase_monthly':
    case 'license_expired':
    case 'license_expiring':
      return { ...base, plan: 'monthly' };
    case 'purchase_lifetime':
      return { ...base, plan: 'lifetime' };
    case 'trial_started':
    case 'trial_download':
    case 'promo_trial_ending':
      return { ...base, plan: 'trial' };
    case 'promo_buy':
      return {
        ...base,
        promoHeadline: 'Your Mac’s notch, finally useful',
        promoBody:
          'We built NotchOS for the things you open all day. Try it free for 7 days — no card — then keep Pro with Monthly or Lifetime.',
      };
    default:
      return base;
  }
}
