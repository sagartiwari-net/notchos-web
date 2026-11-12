/**
 * Tier-A SEO overrides for high-value /vs/[slug] pages.
 * Survives MD regeneration when applied in vs/[slug].astro;
 * generate-vs.mjs also reads this so regenerated bodies stay intentional.
 */
export type VsTierA = {
  /** Visible H1 (alternative + vs intent) */
  h1: string;
  /** Meta description — include “alternative” phrasing */
  description: string;
  /** Optional document title; default keeps “NotchOS vs {App}…” */
  title?: string;
  /** Short lead under H1 / meta — honest competitor ack + NotchOS pitch once */
  lead: string;
  /** Extra footer mesh links (compare / alternatives / guides) */
  mesh?: { href: string; label: string }[];
};

export const VS_TIER_A: Record<string, VsTierA> = {
  stats: {
    h1: 'Stats Alternative: system vitals in the Mac notch',
    title: 'Stats Alternative — NotchOS vs Stats (Mac System Monitor, 2026)',
    description:
      'Looking for a Stats alternative on Mac? NotchOS puts system vitals in a Dynamic Island with tray, clipboard, and timers — $15 lifetime or $3/mo, 7-day trial. First-party comparison; NotchOS is ours. Verify Stats pricing on GitHub.',
    lead: 'Searching for a <strong>Stats alternative</strong>? Stats remains an excellent open-source menu-bar monitor — keep it if you only need deep vitals. <strong>NotchOS</strong> (ours) folds system stats into a Mac notch / Dynamic Island with tray, clipboard, timers, and more at <strong>$15 lifetime</strong> or <strong>$3/mo</strong>, with a <strong>7-day trial</strong> and no card. Official Stats: verify on the vendor link above.',
    mesh: [
      { href: '/blog/mac-system-monitor-notch', label: 'System monitor in the notch' },
      { href: '/vs#monitor', label: 'System monitor compares' },
    ],
  },
  'boring-notch': {
    h1: 'Boring Notch Alternative: free OSS vs a full Mac island',
    title: 'Boring Notch Alternative — NotchOS vs Boring Notch (2026)',
    description:
      'Boring Notch alternative for Mac: compare free open-source Dynamic Island basics to NotchOS — tray, clipboard, teleprompter, Android Share, $15 lifetime / $3 mo, 7-day trial. First-party page; NotchOS is ours.',
    lead: 'Looking for a <strong>Boring Notch alternative</strong>? Boring Notch is the right free OSS starting point for a simple Dynamic Island. <strong>NotchOS</strong> is our paid island for Apple silicon: tray, clipboard, calendar, timers, teleprompter, Android Share, and on-device writing — <strong>$15 lifetime</strong> or <strong>$3/mo</strong>, <strong>7-day trial</strong>, no card. We disclose this is first-party.',
    mesh: [
      { href: '/alternatives/boring-notch', label: 'Boring Notch alternatives' },
      { href: '/compare/notchos-vs-boring-notch', label: 'Long compare: NotchOS vs Boring Notch' },
      { href: '/blog/boring-notch-alternatives', label: 'Boring Notch alternatives guide' },
    ],
  },
  alcove: {
    h1: 'Alcove Alternative: Dynamic Island beyond Now Playing',
    title: 'Alcove Alternative — NotchOS vs Alcove (Mac Notch, 2026)',
    description:
      'Alcove alternative for MacBook notch: NotchOS vs Alcove side-by-side — media polish vs full productivity island (tray, clipboard, timers, prompter). $15 lifetime / $3 mo. First-party; verify Alcove price on tryalcove.com.',
    lead: 'Searching for an <strong>Alcove alternative</strong>? Alcove is a strong polish-first island, especially media (confirm macOS floor and price on their site). <strong>NotchOS</strong> (ours) aims at the whole day under the notch — files, clipboard, timers, teleprompter, Android Share, writing — at <strong>$15 lifetime</strong> or <strong>$3/mo</strong> with a <strong>7-day trial</strong>.',
    mesh: [
      { href: '/alternatives/alcove', label: 'Alcove alternatives' },
      { href: '/compare/notchos-vs-alcove', label: 'Long compare: NotchOS vs Alcove' },
      { href: '/compare/alcove-vs-boring-notch', label: 'Alcove vs Boring Notch' },
    ],
  },
  notchnook: {
    h1: 'NotchNook Alternative: tray + full productivity in the notch',
    title: 'NotchNook Alternative — NotchOS vs NotchNook (2026)',
    description:
      'NotchNook alternative for Mac: NotchOS vs NotchNook — file tray and island widgets vs a multi-face Dynamic Island (clipboard, timers, prompter, Android Share). $15 lifetime / $3 mo. First-party; verify NotchNook pricing upstream.',
    lead: 'Looking for a <strong>NotchNook alternative</strong>? NotchNook is known for tray and design (confirm current price/macOS on getnotchnook.com). <strong>NotchOS</strong> is our island for tray plus clipboard, calendar, timers, teleprompter, Android Share, and writing — <strong>$15 lifetime</strong> or <strong>$3/mo</strong>, <strong>7-day trial</strong>, no card.',
    mesh: [
      { href: '/alternatives/notchnook', label: 'NotchNook alternatives' },
      { href: '/compare/notchos-vs-notchnook', label: 'Long compare: NotchOS vs NotchNook' },
      { href: '/compare/notchnook-vs-boring-notch-vs-alcove', label: 'NotchNook vs Boring Notch vs Alcove' },
    ],
  },
  notchy: {
    h1: 'Notchy Alternative: another Mac Dynamic Island to try',
    title: 'Notchy Alternative — NotchOS vs Notchy (2026)',
    description:
      'Notchy alternative for Mac: honest NotchOS vs Notchy comparison — feature overlap, pricing ($15 lifetime / $3 mo vs verify Notchy on notchy.dev), trial, and when each wins. First-party page; NotchOS is ours.',
    lead: 'Searching for a <strong>Notchy alternative</strong>? Notchy is a polished paid Dynamic Island with a large feature surface (confirm price and macOS on notchy.dev — we do not copy their numbers as ours). <strong>NotchOS</strong> is our product: tray, clipboard, timers, teleprompter, Android Share, on-device writing — <strong>$15 lifetime</strong> or <strong>$3/mo</strong>, <strong>7-day trial</strong>, no card.',
    mesh: [
      { href: '/alternatives/notchy', label: 'Notchy alternatives' },
      { href: '/compare/notchy-vs-notchos', label: 'Long compare: Notchy vs NotchOS' },
    ],
  },
  maccy: {
    h1: 'Maccy Alternative: clipboard history in the Mac notch',
    title: 'Maccy Alternative — NotchOS vs Maccy (Clipboard, 2026)',
    description:
      'Maccy alternative for Mac? NotchOS keeps clipboard history in a Dynamic Island with tray and timers — $15 lifetime / $3 mo, 7-day trial. Keep Maccy when you need specialist depth. First-party; verify Maccy pricing on maccy.app.',
    lead: 'Looking for a <strong>Maccy alternative</strong> that lives in the notch? Maccy is a strong clipboard specialist (free/paid tiers — confirm on maccy.app). <strong>NotchOS</strong> (ours) puts clipboard history under the camera with tray, timers, and the rest of the island — <strong>$15 lifetime</strong> or <strong>$3/mo</strong>, <strong>7-day trial</strong>. Many people keep both when they want deep search and an island.',
    mesh: [
      { href: '/blog/clipboard-manager-mac', label: 'Clipboard in the notch' },
      { href: '/blog/best-mac-clipboard-managers', label: 'Best Mac clipboard managers' },
      { href: '/vs#clipboard', label: 'All clipboard compares' },
    ],
  },
  paste: {
    h1: 'Paste Alternative: Mac clipboard in a Dynamic Island',
    title: 'Paste App Alternative — NotchOS vs Paste (2026)',
    description:
      'Paste alternative for Mac: NotchOS vs Paste — clipboard history in the notch plus tray, timers, and more. $15 lifetime / $3 mo, 7-day trial. First-party comparison; verify Paste pricing on pasteapp.io.',
    lead: 'Searching for a <strong>Paste alternative</strong>? Paste is a popular paid clipboard manager (confirm price and features on pasteapp.io). <strong>NotchOS</strong> is our Mac notch / Dynamic Island app with clipboard history next to tray, calendar, timers, teleprompter, and Android Share — <strong>$15 lifetime</strong> or <strong>$3/mo</strong>, <strong>7-day trial</strong>, no card. Specialists often go deeper on sync and rules; the island wins on proximity.',
    mesh: [
      { href: '/blog/clipboard-manager-mac', label: 'Clipboard in the notch' },
      { href: '/blog/best-mac-clipboard-managers', label: 'Best Mac clipboard managers' },
      { href: '/vs#clipboard', label: 'All clipboard compares' },
    ],
  },
};

export function getVsTierA(slug: string): VsTierA | undefined {
  return VS_TIER_A[slug];
}

export const VS_TIER_A_SLUGS = Object.keys(VS_TIER_A);
