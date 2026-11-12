/**
 * First-party copy templates per app "kind".
 * Woven with the competitor name on each /vs page — no meta-SEO fluff.
 */
import type { VsKind, VsRelation } from './vs-apps';

export type KindCopy = {
  /** H2 for the why section */
  whyTitle: (name: string) => string;
  why: (name: string) => [string, string][];
  /** Short relation line under the lead */
  relationLead: (name: string, relation: VsRelation) => string;
  /** Where the competitor still wins */
  deeperIntro: (name: string) => string;
  usingBoth: (name: string) => string;
  /** Extra FAQ beyond the shared set */
  faq: (name: string) => { q: string; a: string }[];
};

const priceLine =
  'NotchOS is $15 lifetime or $3/month after a 7-day trial with no card.';

function relationLead(name: string, relation: VsRelation): string {
  switch (relation) {
    case 'same':
      return `${name} and NotchOS both sit in the Mac notch / Dynamic Island category — pick by feature surface and price.`;
    case 'covers':
      return `NotchOS covers the same daily job as ${name} inside a multi-face island, and adds tray, clipboard, timers, and more beside it.`;
    case 'partly':
      return `${name} overlaps with part of NotchOS. Specialists often go deeper on one job; the island wins when you want several tools in one hover.`;
    case 'beside':
      return `${name} solves a different job from a productivity Dynamic Island. Keep it when you need that specialty; add NotchOS for the island.`;
  }
}

const baseFaq = (name: string) => [
  {
    q: `Is NotchOS a ${name} alternative?`,
    a: `For search intent, yes — people typing that query want a side-by-side. For product truth, read the sections above: sometimes alternative, sometimes companion. ${priceLine}`,
  },
  {
    q: `Will NotchOS replace ${name}?`,
    a: `Only when the island covers the same workflow you actually open. Launchers, full OCR suites, unlock apps, terminals, and desktop pets are often complements, not replacements.`,
  },
  {
    q: 'How much does NotchOS cost?',
    a: 'Lifetime is $15 one-time; Monthly is $3. There is a 7-day in-app trial with no card. PayPal checkout emails the key to your PayPal address.',
  },
  {
    q: 'Which Macs does NotchOS support?',
    a: 'Apple silicon Macs running macOS 26 or later. Intel Macs are not supported.',
  },
];

export const VS_KINDS: Record<VsKind, KindCopy> = {
  island: {
    whyTitle: (n) => `Why use NotchOS instead of ${n}?`,
    why: (n) => [
      ['One island, many faces', `Tray, clipboard, calendar, timers, teleprompter, Android Share, and writing — not only the media / shelf basics ${n} may focus on.`],
      ['Clear pricing', priceLine],
      ['Built for Apple silicon', 'Native arm64 on macOS 26 or later — check your Mac before you buy.'],
    ],
    relationLead,
    deeperIntro: (n) => `Where ${n} may still win: polish on a narrower feature set, a lower price, open source, or an older macOS floor. Re-check their site.`,
    usingBoth: (n) => `Running two notch apps at once is rarely useful. Pick ${n} or NotchOS after a real workday, not after five minutes of screenshots.`,
    faq: baseFaq,
  },
  'hide-notch': {
    whyTitle: (n) => `Why use NotchOS alongside ${n}?`,
    why: () => [
      ['Different job', 'Hide-the-notch utilities wallpaper over the camera cutout. NotchOS expands that cutout into a usable island.'],
      ['Productivity instead of disguise', 'Tray, clipboard, timers, and teleprompter under the camera — not a black bar.'],
      ['Clear buy path', priceLine],
    ],
    relationLead,
    deeperIntro: (n) => `${n} is the right tool if you only want the notch to disappear. NotchOS is the opposite product direction.`,
    usingBoth: (n) => `You would not run ${n} and NotchOS together — one hides the notch, the other uses it.`,
    faq: baseFaq,
  },
  'ai-island': {
    whyTitle: (n) => `Why use NotchOS instead of ${n}?`,
    why: (n) => [
      ['Island for the whole day', `NotchOS is a productivity Dynamic Island — tray, clipboard, timers, teleprompter — not only an AI-usage pill like ${n}.`],
      ['On-device writing (Pro)', 'Summarize, grammar, rewrite and more in the island without a separate AI bar.'],
      ['Clear pricing', priceLine],
    ],
    relationLead,
    deeperIntro: (n) => `${n} may track more AI models or expose a developer API NotchOS does not. Keep it if that is the whole job.`,
    usingBoth: (n) => `Some people keep an AI-usage tracker and an island. Drop the one whose faces you never open.`,
    faq: baseFaq,
  },
  clipboard: {
    whyTitle: (n) => `Why use NotchOS instead of ${n}?`,
    why: (n) => [
      ['Clipboard in the notch', `History lives under the camera with your other daily faces — not only a ${n}-style panel.`],
      ['More than paste', 'Tray, timers, calendar, and sharing in the same island.'],
      ['One license', priceLine],
    ],
    relationLead,
    deeperIntro: (n) => `${n} often wins on deep search, sync, rules, or a longer history. Keep it when clipboard is 90% of the need.`,
    usingBoth: (n) => `It is valid to keep ${n} for power clipboard work and NotchOS for the island — if you actually open both.`,
    faq: baseFaq,
  },
  'paste-clean': {
    whyTitle: (n) => `Why use NotchOS instead of ${n}?`,
    why: () => [
      ['Strip formatting in the island', 'Plain-text paste sits next to clipboard history, tray, and timers.'],
      ['One hover', 'Not another single-purpose menu-bar tool for one paste habit.'],
      ['Clear pricing', priceLine],
    ],
    relationLead,
    deeperIntro: (n) => `${n} may automate paste-cleaning more aggressively. Keep it if that is all you need.`,
    usingBoth: (n) => `Many people replace ${n} once clipboard + strip-format live in the island.`,
    faq: baseFaq,
  },
  shelf: {
    whyTitle: (n) => `Why use NotchOS instead of ${n}?`,
    why: () => [
      ['File tray in the notch', 'Stage files under the camera — with clipboard and timers beside it.'],
      ['One app instead of a shelf-only utility', 'Tray plus calendar, vitals, and Android Share.'],
      ['$15 lifetime option', 'Or $3/month if you prefer subscription.'],
    ],
    relationLead,
    deeperIntro: (n) => `${n} may offer a larger shelf, better stacks, or cloud handoff NotchOS does not.`,
    usingBoth: (n) => `Keep ${n} if its shelf workflow is muscle memory; add NotchOS only if the island removes other utilities.`,
    faq: baseFaq,
  },
  calendar: {
    whyTitle: (n) => `Why use NotchOS instead of ${n}?`,
    why: () => [
      ['Today under the camera', 'Glance the day without another menu-bar calendar icon.'],
      ['Same island as clipboard & tray', 'Meetings next to the tools you already open.'],
      ['Not a full Fantastical replacement', 'Keep a deep calendar if you need natural-language parse — add NotchOS for the island.'],
    ],
    relationLead,
    deeperIntro: (n) => `${n} wins on grid depth, natural language, or multi-calendar power features.`,
    usingBoth: (n) => `Common setup: ${n} for planning, NotchOS for “what’s next” under the notch.`,
    faq: baseFaq,
  },
  timer: {
    whyTitle: (n) => `Why use NotchOS instead of ${n}?`,
    why: (n) => [
      ['Timers in the island', `Pomodoro, countdown, and stopwatch under the camera — overlap with ${n}, plus clipboard and tray.`],
      ['Keep Awake beside them', 'Caffeine toggle in the same place as the timer.'],
      ['Trial without a card', '7 days to see if the island replaces a timer-only app.'],
    ],
    relationLead,
    deeperIntro: (n) => `${n} may offer richer stats, streaks, or blocked-site focus modes.`,
    usingBoth: (n) => `Drop ${n} if island timers cover your sessions; keep it if you rely on its focus reports.`,
    faq: baseFaq,
  },
  keepawake: {
    whyTitle: (n) => `Why use NotchOS instead of ${n}?`,
    why: () => [
      ['Keep Awake in the island', 'Caffeine toggle next to timers, clipboard, and tray.'],
      ['Fewer icons', 'One island instead of another permanent menu-bar cup.'],
      ['Clear pricing', priceLine],
    ],
    relationLead,
    deeperIntro: (n) => `${n} may expose finer triggers (app-based, trigger on battery, etc.).`,
    usingBoth: (n) => `Most people replace ${n} once Keep Awake lives in the island.`,
    faq: baseFaq,
  },
  breaks: {
    whyTitle: (n) => `Why use NotchOS instead of ${n}?`,
    why: () => [
      ['Timers for sessions and breaks', 'Countdown faces under the notch when you need a pause.'],
      ['Plus the rest of the day', 'Clipboard, tray, and calendar in the same island.'],
      ['Honest scope', 'NotchOS is not a full stretch-reminder suite.'],
    ],
    relationLead,
    deeperIntro: (n) => `${n} wins on break schedules, micro-exercises, and nagging you to look away.`,
    usingBoth: (n) => `Keep ${n} for health breaks; use NotchOS for productivity faces.`,
    faq: baseFaq,
  },
  ambient: {
    whyTitle: (n) => `Why use NotchOS instead of ${n}?`,
    why: () => [
      ['Ambient sounds (Pro)', 'Focus audio in the island next to timers and Keep Awake.'],
      ['Not only sound', 'Tray, clipboard, and calendar in the same place.'],
      ['Clear pricing', priceLine],
    ],
    relationLead,
    deeperIntro: (n) => `${n} may have a larger sound library, scenes, or subscription catalog.`,
    usingBoth: (n) => `Keep ${n} if you live in its soundscapes; NotchOS ambient is a companion, not a full studio.`,
    faq: baseFaq,
  },
  dnd: {
    whyTitle: (n) => `Why use NotchOS instead of ${n}?`,
    why: () => [
      ['Mic mute + meeting adjacency', 'Mute from the island when a call starts; timers and notes beside it.'],
      ['Not a Focus-mode clone', 'Honest scope: NotchOS does not replace Do Not Disturb automation suites.'],
      ['Clear pricing', priceLine],
    ],
    relationLead,
    deeperIntro: (n) => `${n} wins on auto-muting notifications for meeting apps.`,
    usingBoth: (n) => `Keep ${n} for meeting Focus rules; use NotchOS for the island.`,
    faq: baseFaq,
  },
  lyrics: {
    whyTitle: (n) => `Why use NotchOS instead of ${n}?`,
    why: () => [
      ['Media plus productivity', 'Now Playing and lyrics (Pro) sit beside clipboard, tray, and timers.'],
      ['Not lyrics-only', 'Island for the whole workday, not just karaoke.'],
      ['Trial first', '7 days free — decide after a real playlist and a real workday.'],
    ],
    relationLead,
    deeperIntro: (n) => `${n} may sync lyrics more accurately or support more players.`,
    usingBoth: (n) => `Keep ${n} for lyrics depth; use NotchOS when you want media inside a full island.`,
    faq: baseFaq,
  },
  nowplaying: {
    whyTitle: (n) => `Why use NotchOS instead of ${n}?`,
    why: () => [
      ['Now Playing in the island', 'Skip and pause under the camera with your other faces.'],
      ['More than a menu-bar player', 'Clipboard, tray, and timers in the same hover.'],
      ['Clear pricing', priceLine],
    ],
    relationLead,
    deeperIntro: (n) => `${n} may support more players or a thinner always-on control.`,
    usingBoth: (n) => `Usually one media control is enough — pick the surface you actually look at.`,
    faq: baseFaq,
  },
  audio: {
    whyTitle: (n) => `Why use NotchOS instead of ${n}?`,
    why: () => [
      ['Different depth', 'NotchOS is not a per-app EQ or routing suite — it is a productivity island with media controls.'],
      ['Honest complement', 'Keep pro audio tools; add the island for tray, clipboard, and timers.'],
      ['Clear pricing', priceLine],
    ],
    relationLead,
    deeperIntro: (n) => `${n} wins on routing, EQ, and device switching depth.`,
    usingBoth: (n) => `Keep ${n} for audio engineering; NotchOS does not replace it.`,
    faq: baseFaq,
  },
  hud: {
    whyTitle: (n) => `Why use NotchOS instead of ${n}?`,
    why: () => [
      ['Beyond one HUD', 'Volume/brightness-style glances plus clipboard, tray, and Keep Awake.'],
      ['Fewer icons', 'One island instead of another permanent menu-bar meter.'],
      ['System vitals face', 'CPU/memory style glances without opening Activity Monitor.'],
    ],
    relationLead,
    deeperIntro: (n) => `${n} may polish one control harder (volume HUD style, skinning, etc.).`,
    usingBoth: (n) => `Keep a favorite HUD if you love it; use NotchOS to retire the rest of the icon forest.`,
    faq: baseFaq,
  },
  menubar: {
    whyTitle: (n) => `Why use NotchOS instead of ${n}?`,
    why: () => [
      ['Fewer icons by design', 'Park daily tools under the camera instead of hiding a crowded menu bar.'],
      ['Not a Bartender clone', 'Honest scope: NotchOS does not hide menu-bar icons.'],
      ['Clear pricing', priceLine],
    ],
    relationLead,
    deeperIntro: (n) => `${n} wins if your problem is icon overflow. NotchOS wins if your problem is too many single-purpose apps.`,
    usingBoth: (n) => `Common pair: ${n} to tidy icons, NotchOS for the island.`,
    faq: baseFaq,
  },
  toggles: {
    whyTitle: (n) => `Why use NotchOS instead of ${n}?`,
    why: () => [
      ['Toggles next to real work', 'Keep Awake, mic mute, and eject live with clipboard and tray.'],
      ['Not 50 switches', 'Honest scope: NotchOS does not expose every macOS toggle.'],
      ['Clear pricing', priceLine],
    ],
    relationLead,
    deeperIntro: (n) => `${n} wins as a switchboard for dozens of system toggles.`,
    usingBoth: (n) => `Keep ${n} for rare toggles; use NotchOS for daily faces.`,
    faq: baseFaq,
  },
  monitor: {
    whyTitle: (n) => `Why use NotchOS instead of ${n}?`,
    why: (n) => [
      ['Vitals in the island', `CPU, memory, and activity under the camera — the job ${n} does in the menu bar, next to tray and timers.`],
      ['One app instead of a monitor-only tool', 'Stats plus clipboard, calendar, and Keep Awake.'],
      ['Clear pricing', priceLine],
    ],
    relationLead,
    deeperIntro: (n) => `${n} usually wins on per-process detail, sensors, graphs, and historical charts.`,
    usingBoth: (n) => `Power users often keep ${n} for deep vitals and NotchOS for the island glance.`,
    faq: baseFaq,
  },
  battery: {
    whyTitle: (n) => `Why use NotchOS instead of ${n}?`,
    why: () => [
      ['Battery glances in the island', 'Charge and related live activities under the camera.'],
      ['Not a charge-limit suite', 'Honest scope: NotchOS does not replace AlDente-class battery care.'],
      ['Clear pricing', priceLine],
    ],
    relationLead,
    deeperIntro: (n) => `${n} wins on charge limits, calibration, and health metrics.`,
    usingBoth: (n) => `Keep ${n} for battery health; use NotchOS for productivity faces.`,
    faq: baseFaq,
  },
  teleprompter: {
    whyTitle: (n) => `Why use NotchOS instead of ${n}?`,
    why: () => [
      ['Prompter under the camera', 'Scroll your script in the notch — looking at the lens stays natural.'],
      ['Same island as timers and notes', 'One place for the talk, not a separate floating window only.'],
      ['Clear pricing', priceLine],
    ],
    relationLead,
    deeperIntro: (n) => `${n} may offer richer scripting, remote control, or multi-screen prompter layouts.`,
    usingBoth: (n) => `Keep ${n} for long-form productions; try NotchOS when the island prompter is enough.`,
    faq: baseFaq,
  },
  window: {
    whyTitle: (n) => `Why use NotchOS alongside ${n}?`,
    why: () => [
      ['Complement to snapping', 'Keep your snapper — NotchOS is not a tiling window manager.'],
      ['Island for everything else', 'Clipboard, tray, timers while windows snap elsewhere.'],
      ['Window Snap (Pro)', 'Light snap helpers in the island — not a Rectangle replacement.'],
    ],
    relationLead,
    deeperIntro: (n) => `${n} wins on layouts, gaps, spaces, and keyboard-driven tiling.`,
    usingBoth: (n) => `Best setup for most people: ${n} + NotchOS.`,
    faq: baseFaq,
  },
  launcher: {
    whyTitle: (n) => `Why use NotchOS alongside ${n}?`,
    why: () => [
      ['Complement, not a Raycast clone', 'Keep your launcher for power search — use the island for daily faces.'],
      ['Snippets adjacency', 'Clipboard history in the notch for quick pastes.'],
      ['Less icon clutter', 'Park timers and tray under the camera.'],
    ],
    relationLead,
    deeperIntro: (n) => `${n} wins on extensions, clipboard history depth, and command palettes.`,
    usingBoth: (n) => `Recommended: keep ${n}, add NotchOS.`,
    faq: baseFaq,
  },
  snippets: {
    whyTitle: (n) => `Why use NotchOS instead of ${n}?`,
    why: () => [
      ['Clipboard history nearby', 'Saved pastes and history under the camera.'],
      ['Not a full expander', 'Honest scope: NotchOS is not TextExpander.'],
      ['Clear pricing', priceLine],
    ],
    relationLead,
    deeperIntro: (n) => `${n} wins on abbreviation expansion, fill-ins, and team snippet sync.`,
    usingBoth: (n) => `Keep ${n} for expansion; use NotchOS for the island.`,
    faq: baseFaq,
  },
  ocr: {
    whyTitle: (n) => `Why use NotchOS alongside ${n}?`,
    why: () => [
      ['After you capture', 'Paste into clipboard history in the island — keep the capture app for pro shots.'],
      ['Not a full OCR suite', 'Honest scope: NotchOS is the island, specialists win on annotate/record.'],
      ['One place for follow-up', 'Files in the tray, text in clipboard, timers when you need them.'],
    ],
    relationLead,
    deeperIntro: (n) => `${n} wins on capture quality, annotation, OCR accuracy, and cloud share links.`,
    usingBoth: (n) => `Keep ${n}; NotchOS handles what happens after the capture.`,
    faq: baseFaq,
  },
  capture: {
    whyTitle: (n) => `Why use NotchOS alongside ${n}?`,
    why: () => [
      ['Tray for staged shots', 'Drop captures into the notch tray to drag later.'],
      ['Clipboard history after OCR', 'Text you copy lands next to your other faces.'],
      ['Honest complement', 'NotchOS is not CleanShot.'],
    ],
    relationLead,
    deeperIntro: (n) => `${n} is the capture specialist. NotchOS will not replace it.`,
    usingBoth: (n) => `Keep ${n} + NotchOS.`,
    faq: baseFaq,
  },
  color: {
    whyTitle: (n) => `Why use NotchOS alongside ${n}?`,
    why: () => [
      ['Different job', 'Color pickers are design tools. NotchOS is a productivity island.'],
      ['Clipboard for hex pastes', 'Once you copy a color, history lives under the camera.'],
      ['Clear pricing', priceLine],
    ],
    relationLead,
    deeperIntro: (n) => `${n} wins on contrast checks, palettes, and format conversions.`,
    usingBoth: (n) => `Keep ${n}; add NotchOS for the island.`,
    faq: baseFaq,
  },
  unlock: {
    whyTitle: (n) => `Why use NotchOS alongside ${n}?`,
    why: () => [
      ['Different job', 'Unlock apps own security — NotchOS owns the productivity island.'],
      ['Honest compare', 'We do not invent Face ID claims.'],
      ['Use both', 'Keep unlock; add NotchOS for tray, clipboard, and timers.'],
    ],
    relationLead,
    deeperIntro: (n) => `${n} is the unlock tool. NotchOS will not replace it.`,
    usingBoth: (n) => `Keep ${n} + NotchOS.`,
    faq: baseFaq,
  },
  'ai-usage': {
    whyTitle: (n) => `Why use NotchOS instead of ${n}?`,
    why: () => [
      ['On-device writing (Pro)', 'Draft help in the island — not a full usage-dashboard replacement.'],
      ['System vitals nearby', 'Watch load while agents run.'],
      ['Productivity island', 'Tray and clipboard for the files those tools produce.'],
    ],
    relationLead,
    deeperIntro: (n) => `${n} wins on per-model token dashboards and multi-provider tracking.`,
    usingBoth: (n) => `Keep ${n} if you live in agent usage charts; NotchOS is the island layer.`,
    faq: baseFaq,
  },
  terminal: {
    whyTitle: (n) => `Why use NotchOS alongside ${n}?`,
    why: () => [
      ['Different job', 'Terminals are for shells. NotchOS is a productivity Dynamic Island.'],
      ['Vitals while you build', 'System face for CPU/memory next to your session.'],
      ['Clear pricing', priceLine],
    ],
    relationLead,
    deeperIntro: (n) => `${n} is your terminal. NotchOS will not replace it.`,
    usingBoth: (n) => `Keep ${n} + NotchOS.`,
    faq: baseFaq,
  },
  dictation: {
    whyTitle: (n) => `Why use NotchOS alongside ${n}?`,
    why: () => [
      ['Complement to voice apps', 'Keep dictation; NotchOS is the island layer after text lands.'],
      ['Writing face (Pro)', 'On-device edits after you dictate.'],
      ['Clipboard history', 'Paste cleaned text from the notch.'],
    ],
    relationLead,
    deeperIntro: (n) => `${n} wins on models, languages, and push-to-talk UX.`,
    usingBoth: (n) => `Keep ${n} + NotchOS.`,
    faq: baseFaq,
  },
  mirror: {
    whyTitle: (n) => `Why use NotchOS instead of ${n}?`,
    why: () => [
      ['Webcam mirror in the island', 'Quick appearance check under the camera before a call.'],
      ['Same place as the prompter', 'Mirror, script, and timers together.'],
      ['Clear pricing', priceLine],
    ],
    relationLead,
    deeperIntro: (n) => `${n} may offer a larger always-on mirror window.`,
    usingBoth: (n) => `Usually one mirror is enough.`,
    faq: baseFaq,
  },
  privacy: {
    whyTitle: (n) => `Why use NotchOS alongside ${n}?`,
    why: () => [
      ['Different job', 'Camera/mic guards are security tools. NotchOS is a productivity island.'],
      ['Honest complement', 'Keep the guard; add the island for daily faces.'],
      ['Clear pricing', priceLine],
    ],
    relationLead,
    deeperIntro: (n) => `${n} wins on access alerts and blocking.`,
    usingBoth: (n) => `Keep ${n} + NotchOS.`,
    faq: baseFaq,
  },
  micmute: {
    whyTitle: (n) => `Why use NotchOS instead of ${n}?`,
    why: () => [
      ['Mic mute in the island', 'Mute across meeting apps from under the camera.'],
      ['Meeting adjacency', 'Timers, notes, and clipboard in the same hover.'],
      ['Clear pricing', priceLine],
    ],
    relationLead,
    deeperIntro: (n) => `${n} may auto-mute on join or expose more input devices.`,
    usingBoth: (n) => `Replace ${n} if island mute covers you; keep it if you rely on its automations.`,
    faq: baseFaq,
  },
  android: {
    whyTitle: (n) => `Why use NotchOS instead of ${n}?`,
    why: () => [
      ['Android Share in the island', 'Move files between Mac and Android on the same Wi-Fi from under the camera.'],
      ['Same place as tray & clipboard', 'Receive a file, stage it, paste — one island.'],
      ['Clear pricing', priceLine],
    ],
    relationLead,
    deeperIntro: (n) => `${n} may support more platforms, larger transfers, or no Mac-app install.`,
    usingBoth: (n) => `Keep ${n} for cross-platform bulk transfer; use NotchOS when Android Share in the island is enough.`,
    faq: baseFaq,
  },
  widgets: {
    whyTitle: (n) => `Why use NotchOS instead of ${n}?`,
    why: () => [
      ['Island instead of wallpaper widgets', 'Stats and tools under the notch, not covering the desktop.'],
      ['Built-in vitals', 'System face without scripting a full widget setup.'],
      ['One app', 'Tray + clipboard + timers with the same chrome.'],
    ],
    relationLead,
    deeperIntro: (n) => `${n} wins on custom layouts and desktop real estate.`,
    usingBoth: (n) => `Pick wallpaper widgets or the island — stacking both is usually noise.`,
    faq: baseFaq,
  },
  screentime: {
    whyTitle: (n) => `Why use NotchOS alongside ${n}?`,
    why: () => [
      ['Different job', 'Screen-time trackers measure usage. NotchOS is a productivity Dynamic Island.'],
      ['Honest compare', 'We do not pretend the island replaces RescueTime-class analytics.'],
      ['Clear pricing', priceLine],
    ],
    relationLead,
    deeperIntro: (n) => `${n} wins on reports, blockers, and habit scoring.`,
    usingBoth: (n) => `Keep ${n} + NotchOS.`,
    faq: baseFaq,
  },
  pet: {
    whyTitle: (n) => `Why try NotchOS if you use ${n}?`,
    why: () => [
      ['Different job', 'Desktop pets are fun — NotchOS is a productivity Dynamic Island.'],
      ['Vitals with purpose', 'System face for real CPU/memory, not only a running cat.'],
      ['Try anyway', 'If you want the island, the trial is free for 7 days.'],
    ],
    relationLead,
    deeperIntro: (n) => `${n} is entertainment. NotchOS will not replace it.`,
    usingBoth: (n) => `Run both if you want — they do not compete.`,
    faq: baseFaq,
  },
  keycast: {
    whyTitle: (n) => `Why use NotchOS alongside ${n}?`,
    why: () => [
      ['Presentation adjacency', 'Teleprompter face for talks; keep the cursor tool for spotlight.'],
      ['One island for the talk', 'Timers, notes, and clipboard under the notch.'],
      ['Honest complement', 'Cursor tools and NotchOS solve different layers.'],
    ],
    relationLead,
    deeperIntro: (n) => `${n} wins on keystroke HUDs and cursor highlights.`,
    usingBoth: (n) => `Keep ${n} for demos; NotchOS for the island.`,
    faq: baseFaq,
  },
  utilities: {
    whyTitle: (n) => `Why use NotchOS instead of ${n}?`,
    why: (n) => [
      ['One app instead of dozens', `NotchOS overlaps on the job ${n} covers and adds tray, clipboard, timers, and more.`],
      ['Island workflow', 'Hover the camera housing instead of hunting another utility.'],
      ['Clear buy path', `Try 7 days free, then $15 lifetime or $3/month.`],
    ],
    relationLead,
    deeperIntro: (n) => `${n} may still be the right specialist. Re-check their site for depth we do not claim.`,
    usingBoth: (n) => `Keep ${n} when it still wins on depth. Add NotchOS only if the island removes other single-purpose apps.`,
    faq: baseFaq,
  },
};

export function getKindCopy(kind: VsKind): KindCopy {
  return VS_KINDS[kind] ?? VS_KINDS.utilities;
}
