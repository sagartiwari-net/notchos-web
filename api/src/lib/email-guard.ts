// Reject disposable / typo emails for trial-lead capture.
// Real device trials still start only inside the Mac app (POST /v1/trial).

import { resolve4, resolveMx } from 'node:dns/promises';

export type EmailGuardFail =
  | { ok: false; reason: 'format' | 'disposable' | 'typo' | 'no_mx'; hint?: string }
  | { ok: true; email: string };

/** Common throwaway / temp-mail domains (lowercase). */
const DISPOSABLE = new Set([
  '10minutemail.com',
  '1secmail.com',
  'anonaddy.com',
  'guerrillamail.com',
  'guerrillamail.de',
  'guerrillamail.net',
  'guerrillamail.org',
  'sharklasers.com',
  'grr.la',
  'guerrillamailblock.com',
  'mailinator.com',
  'mailinator.net',
  'mailinator2.com',
  'tempmail.com',
  'temp-mail.org',
  'temp-mail.io',
  'tmpmail.org',
  'tmpmail.net',
  'trashmail.com',
  'trashmail.me',
  'yopmail.com',
  'yopmail.fr',
  'yopmail.net',
  'getnada.com',
  'nada.email',
  'discard.email',
  'discardmail.com',
  'mailnesia.com',
  'maildrop.cc',
  'fakeinbox.com',
  'throwawaymail.com',
  'moakt.com',
  'emailondeck.com',
  'mintemail.com',
  'mytemp.email',
  'tempail.com',
  'tempr.email',
  'dispostable.com',
  'mailcatch.com',
  'inboxkitten.com',
  'burnermail.io',
  'mailnull.com',
  'spamgourmet.com',
  'getairmail.com',
  'emailfake.com',
  'crazymailing.com',
  'mohmal.com',
  'tempinbox.com',
  '33mail.com',
  'mailforspam.com',
]);

/** Frequent typos → suggested real domain. */
const TYPO_FIX: Record<string, string> = {
  'gma.com': 'gmail.com',
  'gmial.com': 'gmail.com',
  'gmal.com': 'gmail.com',
  'gamil.com': 'gmail.com',
  'gnail.com': 'gmail.com',
  'gmai.com': 'gmail.com',
  'gmail.co': 'gmail.com',
  'gmail.cm': 'gmail.com',
  'gmail.con': 'gmail.com',
  'gmail.cmo': 'gmail.com',
  'gmail.om': 'gmail.com',
  'hotmal.com': 'hotmail.com',
  'hotmai.com': 'hotmail.com',
  'hotmial.com': 'hotmail.com',
  'hotmail.co': 'hotmail.com',
  'outlok.com': 'outlook.com',
  'outllok.com': 'outlook.com',
  'outlook.co': 'outlook.com',
  'yaho.com': 'yahoo.com',
  'yahooo.com': 'yahoo.com',
  'yahoo.co': 'yahoo.com',
  'icloud.co': 'icloud.com',
  'icoud.com': 'icloud.com',
  'protonmai.com': 'protonmail.com',
};

function domainOf(email: string): string {
  const at = email.lastIndexOf('@');
  return at === -1 ? '' : email.slice(at + 1);
}

export function normalizeEmailShape(input: string): string | null {
  const email = input.trim().toLowerCase();
  if (email.length < 5 || email.length > 254) return null;
  // Require a real-looking local + domain.tld (tld at least 2 chars).
  if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(email)) return null;
  if (email.includes('..') || email.startsWith('.') || email.includes('.@')) return null;
  return email;
}

/**
 * Sync checks (format, disposable, typo). Call `assertMailboxMx` after for DNS.
 */
export function guardEmailSync(input: string): EmailGuardFail {
  const email = normalizeEmailShape(input);
  if (email === null) return { ok: false, reason: 'format' };

  const domain = domainOf(email);
  if (DISPOSABLE.has(domain)) {
    return { ok: false, reason: 'disposable' };
  }
  // Also block obvious subdomain disposable hosts: foo.mailinator.com
  for (const bad of DISPOSABLE) {
    if (domain.endsWith('.' + bad)) return { ok: false, reason: 'disposable' };
  }

  const fix = TYPO_FIX[domain];
  if (fix !== undefined) {
    return { ok: false, reason: 'typo', hint: `${email.slice(0, email.indexOf('@') + 1)}${fix}` };
  }

  return { ok: true, email };
}

/** Domain must have MX or at least an A record (some small hosts use A-only). */
export async function assertMailboxMx(email: string, timeoutMs = 2500): Promise<boolean> {
  const domain = domainOf(email);
  if (domain === '') return false;

  const work = (async () => {
    try {
      const mx = await resolveMx(domain);
      if (mx.length > 0) return true;
    } catch {
      // fall through to A
    }
    try {
      const a = await resolve4(domain);
      return a.length > 0;
    } catch {
      return false;
    }
  })();

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(true), timeoutMs); // fail-open on DNS timeout
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function guardEmail(input: string): Promise<EmailGuardFail> {
  const sync = guardEmailSync(input);
  if (!sync.ok) return sync;
  const mxOk = await assertMailboxMx(sync.email);
  if (!mxOk) return { ok: false, reason: 'no_mx' };
  return sync;
}

export function guardMessage(fail: Extract<EmailGuardFail, { ok: false }>): string {
  switch (fail.reason) {
    case 'format':
      return 'Enter a valid email address.';
    case 'disposable':
      return 'Temporary or disposable email addresses are not allowed. Use a permanent inbox.';
    case 'typo':
      return fail.hint ? `That email looks mistyped. Did you mean ${fail.hint}?` : 'That email domain looks mistyped.';
    case 'no_mx':
      return 'That email domain cannot receive mail. Check the address and try again.';
  }
}
