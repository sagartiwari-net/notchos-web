// Share-for-discount: save email + links, issue a single-use Lifetime coupon (5% × networks).

import type { Db } from '../db/pool.ts';
import { selectOne, withTransaction, write } from '../db/pool.ts';
import { createSocialCoupon } from './coupons.ts';

const ALLOWED_HOSTS: Record<string, RegExp> = {
  linkedin: /(^|\.)linkedin\.com$/i,
  facebook: /(^|\.)(facebook\.com|fb\.watch|fb\.com)$/i,
  instagram: /(^|\.)instagram\.com$/i,
  x: /(^|\.)(x\.com|twitter\.com)$/i,
};

export interface SocialShareInput {
  email: string;
  linkedinUrl?: string | null;
  facebookUrl?: string | null;
  instagramUrl?: string | null;
  instagramProfileUrl?: string | null;
  xUrl?: string | null;
}

export type SocialShareOutcome =
  | { ok: true; couponCode: string; percent: number; networks: number; email: string }
  | { ok: false; error: 'invalid_email' | 'no_links' | 'bad_url' | 'limit'; message: string };

function normalizeEmail(raw: string): string | null {
  const email = raw.trim().toLowerCase();
  if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(email)) return null;
  if (email.length > 254) return null;
  return email;
}

function normalizeHttpUrl(raw: string | null | undefined, network: keyof typeof ALLOWED_HOSTS): string | null {
  if (raw === undefined || raw === null) return null;
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  const hostPattern = ALLOWED_HOSTS[network];
  if (!hostPattern || !hostPattern.test(url.hostname)) return null;
  // Block obvious SSRF targets.
  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.local') || /^\d+\.\d+\.\d+\.\d+$/.test(host)) return null;
  return url.toString();
}

export async function submitSocialShare(db: Db, input: SocialShareInput): Promise<SocialShareOutcome> {
  const email = normalizeEmail(input.email);
  if (email === null) return { ok: false, error: 'invalid_email', message: 'Enter a valid email address.' };

  const linkedin = normalizeHttpUrl(input.linkedinUrl, 'linkedin');
  const facebook = normalizeHttpUrl(input.facebookUrl, 'facebook');
  const instagram = normalizeHttpUrl(input.instagramUrl, 'instagram');
  const instagramProfile = normalizeHttpUrl(input.instagramProfileUrl, 'instagram');
  const x = normalizeHttpUrl(input.xUrl, 'x');

  // Reject if any field was non-empty but failed host checks.
  const rawPairs: Array<[string | null | undefined, string | null]> = [
    [input.linkedinUrl, linkedin],
    [input.facebookUrl, facebook],
    [input.instagramUrl, instagram],
    [input.instagramProfileUrl, instagramProfile],
    [input.xUrl, x],
  ];
  for (const [raw, ok] of rawPairs) {
    if (raw && raw.trim() !== '' && ok === null) {
      return { ok: false, error: 'bad_url', message: 'Use a full https link from LinkedIn, Facebook, Instagram, or X.' };
    }
  }

  if (instagram !== null && instagramProfile === null) {
    return {
      ok: false,
      error: 'bad_url',
      message: 'Instagram posts need your profile URL as well.',
    };
  }

  const networks =
    (linkedin ? 1 : 0) + (facebook ? 1 : 0) + (instagram ? 1 : 0) + (x ? 1 : 0);
  if (networks < 1) {
    return { ok: false, error: 'no_links', message: 'Add at least one share link.' };
  }

  const percent = Math.min(20, networks * 5);

  // One unused social coupon per contact email at a time.
  const existing = await selectOne<{ id: number }>(
    db,
    `SELECT c.id
       FROM coupons c
       JOIN social_share_submissions s ON s.coupon_id = c.id
      WHERE s.contact_email = ?
        AND c.kind = 'social'
        AND c.status = 'active'
        AND c.redemption_count < c.max_redemptions
      LIMIT 1`,
    [email],
  );
  if (existing !== null) {
    return {
      ok: false,
      error: 'limit',
      message: 'You already have an unused share coupon for this email. Use it at Lifetime checkout, or wait until it is used.',
    };
  }

  return withTransaction(db, async (tx) => {
    const insert = await write(
      tx,
      `INSERT INTO social_share_submissions
         (contact_email, linkedin_url, facebook_url, instagram_url, instagram_profile_url, x_url,
          networks_claimed, percent_requested, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'submitted')`,
      [email, linkedin, facebook, instagram, instagramProfile, x, networks, percent],
    );
    const submissionId = Number(insert.insertId);
    const coupon = await createSocialCoupon(tx, { percent, socialSubmissionId: submissionId });
    await write(
      tx,
      `UPDATE social_share_submissions
          SET coupon_id = ?, status = 'coupon_issued', updated_at = CURRENT_TIMESTAMP(3)
        WHERE id = ?`,
      [coupon.id, submissionId],
    );
    return { ok: true as const, couponCode: coupon.code, percent, networks, email };
  });
}
