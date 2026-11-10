// S1 check run: screenshots at desktop and phone width, with and without reduced motion,
// plus the behaviour checks the plan asks for (every face opens, hover peeks, click opens,
// click outside and Escape close, tabs work from the keyboard, nothing scrolls sideways,
// no console errors, no requests leaving this machine).
//
//   npm run dev            (or: npm run build && npm run preview)
//   npm run shots          -> screenshots/*.png and screenshots/report.json
//
// Exit code 1 when any check fails.

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SITE_URL, assertSiteUp, launch, sleep } from './browser.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'screenshots');
const rel = (file) => path.relative(root, file);

const WIDTHS = [
  { width: 1440, height: 900, dpr: 1, mobile: false },
  { width: 390, height: 844, dpr: 2, mobile: true },
];

const results = [];
const problems = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};

await assertSiteUp();
await mkdir(outDir, { recursive: true });
const { browser, close } = await launch();

async function open(page, query, { reduce = false } = {}) {
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: reduce ? 'reduce' : 'no-preference' }]);
  await page.goto(new URL(`/${query}`, SITE_URL).href, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => document.querySelector('#stage-notch')?.dataset.ready === 'true');
  await sleep(350);
}

const notchState = (page) =>
  page.evaluate(() => {
    const el = document.getElementById('stage-notch');
    return { state: el.dataset.state, face: el.dataset.face, mode: el.dataset.mode, busy: el.dataset.busy === 'true' };
  });

/** Wait until the stage notch reports a state and has stopped morphing. */
async function settled(page, state) {
  await page.waitForFunction(
    (s) => {
      const el = document.getElementById('stage-notch');
      return el.dataset.state === s && !el.dataset.busy;
    },
    { timeout: 4000 },
    state,
  );
  await sleep(90);
}

/** Space kept free above an element, so the sticky nav never lies over it in a screenshot. */
const NAV_CLEARANCE = 150;

async function shotOf(page, selector, file) {
  const el = await page.$(selector);
  const height = await el.evaluate((node) => node.getBoundingClientRect().height);
  const view = page.viewport();
  // A section taller than the window: make the window taller for this one shot, instead of
  // capturing beyond the viewport (which paints the sticky nav into the middle of the picture).
  const tall = height + NAV_CLEARANCE > view.height;
  if (tall) {
    await page.setViewport({ ...view, height: Math.ceil(height + NAV_CLEARANCE) });
    await sleep(150);
  }
  await el.evaluate((node, block) => node.scrollIntoView({ block, behavior: 'instant' }), tall ? 'end' : 'center');
  await sleep(120);
  await el.screenshot({ path: file, captureBeyondViewport: false });
  if (tall) {
    await page.setViewport(view);
    await sleep(150);
  }
  return rel(file);
}

async function fullPage(page, file) {
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
  await sleep(120);
  await page.screenshot({ path: file, fullPage: true });
  return rel(file);
}

/** Centre of the closed lip of the stage notch, in viewport coordinates. */
const lipPoint = (page) =>
  page.evaluate(() => {
    const el = document.getElementById('stage-notch');
    el.scrollIntoView({ block: 'center', behavior: 'instant' });
    const box = el.getBoundingClientRect();
    return { x: box.left, y: box.top + 12 };
  });

try {
  for (const view of WIDTHS) {
    const tag = String(view.width);
    const page = await browser.newPage();
    const consoleProblems = [];
    const requests = new Set();
    page.on('console', (msg) => {
      if (['error', 'warning'].includes(msg.type())) consoleProblems.push(`${msg.type()}: ${msg.text()}`);
    });
    page.on('pageerror', (error) => consoleProblems.push(`pageerror: ${error.message}`));
    page.on('requestfailed', (request) => {
      // /download and #pricing are placeholders for S2; nothing on the page requests them.
      consoleProblems.push(`requestfailed: ${request.url()} ${request.failure()?.errorText ?? ''}`);
    });
    page.on('request', (request) => requests.add(new URL(request.url()).host));
    await page.setViewport({
      width: view.width,
      height: view.height,
      deviceScaleFactor: view.dpr,
      isMobile: view.mobile,
      hasTouch: view.mobile,
    });

    console.log(`\n=== ${view.width}px wide (dpr ${view.dpr}) ===`);

    // ---- full page, a face open so the stage is not an empty screen
    await open(page, '?face=home');
    console.log(`saved ${await fullPage(page, path.join(outDir, `${tag}-page.png`))}`);
    const overflow = await page.evaluate(() => ({
      scroll: document.documentElement.scrollWidth,
      client: document.documentElement.clientWidth,
    }));
    check(`${tag}: nothing scrolls sideways`, overflow.scroll <= overflow.client, `scrollWidth ${overflow.scroll}, viewport ${overflow.client}`);
    const mode = (await notchState(page)).mode;
    check(`${tag}: stage notch layout`, mode === (view.mobile ? 'compact' : 'wide'), `data-mode=${mode}`);

    // ---- ?face= opens that face and stops the loop
    const viaParam = await page.evaluate(() => ({
      state: document.getElementById('stage-notch').dataset.state,
      autoplay: document.querySelector('[data-stage]').dataset.autoplay,
    }));
    check(`${tag}: ?face=home opens Home and stops autoplay`, viaParam.state === 'open:home' && viaParam.autoplay === 'off', JSON.stringify(viaParam));

    // ---- closed, live activities on the closed lip, peek
    await open(page, '?state=closed');
    console.log(`saved ${await shotOf(page, '.mac', path.join(outDir, `${tag}-stage-closed.png`))}`);
    await open(page, '?state=closed&right=music&left=shelf');
    console.log(`saved ${await shotOf(page, '.mac', path.join(outDir, `${tag}-stage-closed-live.png`))}`);

    if (!view.mobile) {
      // Real pointer: hover -> peek, leave -> closed, click -> open, Escape -> closed,
      // click -> open, click outside -> closed.
      await open(page, '?state=closed&right=timer');
      const lip = await lipPoint(page);
      await page.mouse.move(lip.x, lip.y);
      await settled(page, 'peek').catch(() => {});
      check(`${tag}: hover on the closed notch peeks`, (await notchState(page)).state === 'peek');
      console.log(`saved ${await shotOf(page, '.mac', path.join(outDir, `${tag}-stage-peek.png`))}`);
      const lip2 = await lipPoint(page);
      await page.mouse.move(lip2.x, lip2.y + 300);
      await settled(page, 'closed').catch(() => {});
      check(`${tag}: pointer leaves, notch closes again`, (await notchState(page)).state === 'closed');
      await page.mouse.click(lip2.x, lip2.y);
      await settled(page, 'open:home').catch(() => {});
      check(`${tag}: click opens the notch`, (await notchState(page)).state === 'open:home');
      await page.keyboard.press('Escape');
      await settled(page, 'closed').catch(() => {});
      check(`${tag}: Escape closes it`, (await notchState(page)).state === 'closed');
      await page.mouse.click(lip2.x, lip2.y);
      await settled(page, 'open:home').catch(() => {});
      await page.mouse.click(lip2.x - 480, lip2.y + 420);
      await settled(page, 'closed').catch(() => {});
      check(`${tag}: click outside closes it`, (await notchState(page)).state === 'closed');
      // A tab plate inside the open island switches the face.
      await page.mouse.click(lip2.x, lip2.y);
      await settled(page, 'open:home').catch(() => {});
      await page.click('#stage-notch [data-island-tab="calendar"]');
      await settled(page, 'open:calendar').catch(() => {});
      check(`${tag}: a tab plate inside the island switches the face`, (await notchState(page)).state === 'open:calendar');
    } else {
      await open(page, '?state=peek&right=timer');
      console.log(`saved ${await shotOf(page, '.mac', path.join(outDir, `${tag}-stage-peek.png`))}`);
      // Touch: tap opens, tap outside closes.
      await open(page, '?state=closed');
      const lip = await lipPoint(page);
      await page.touchscreen.tap(lip.x, lip.y);
      await settled(page, 'open:home').catch(() => {});
      check(`${tag}: tap opens the notch`, (await notchState(page)).state === 'open:home');
      await page.touchscreen.tap(lip.x - 150, lip.y + 380);
      await settled(page, 'closed').catch(() => {});
      check(`${tag}: tap outside closes it`, (await notchState(page)).state === 'closed');
    }

    // ---- every face, through its tab
    await open(page, '?autoplay=0');
    const faces = await page.evaluate(() => [...window.NotchOS.faces]);
    const opened = [];
    for (const face of faces) {
      await page.click(`[role="tab"][data-face="${face}"]`);
      let ok = true;
      await settled(page, `open:${face}`).catch(() => (ok = false));
      const selected = await page.evaluate(
        (f) => document.querySelector(`[role="tab"][data-face="${f}"]`).getAttribute('aria-selected') === 'true',
        face,
      );
      const copy = await page.evaluate(
        (f) => !document.querySelector(`[data-face-copy="${f}"]`).hidden,
        face,
      );
      opened.push({ face, ok: ok && selected && copy });
      console.log(`saved ${await shotOf(page, '.mac', path.join(outDir, `${tag}-face-${face}.png`))}`);
    }
    check(
      `${tag}: all ten faces open from their tabs`,
      opened.length === 10 && opened.every((o) => o.ok),
      opened.map((o) => `${o.face}:${o.ok ? 'ok' : 'FAIL'}`).join(' '),
    );

    // ---- tabs from the keyboard
    if (!view.mobile) {
      await page.focus('[role="tab"][data-face="home"]');
      await page.keyboard.press('ArrowRight');
      await settled(page, 'open:tray').catch(() => {});
      const afterRight = await page.evaluate(() => document.activeElement?.getAttribute('data-face'));
      await page.keyboard.press('End');
      await settled(page, 'open:ai').catch(() => {});
      const afterEnd = (await notchState(page)).state;
      await page.keyboard.press('ArrowRight');
      await settled(page, 'open:home').catch(() => {});
      const wrapped = (await notchState(page)).state;
      check(
        `${tag}: arrow keys, End and wrap-around move through the tabs`,
        afterRight === 'tray' && afterEnd === 'open:ai' && wrapped === 'open:home',
        `ArrowRight -> ${afterRight}, End -> ${afterEnd}, ArrowRight -> ${wrapped}`,
      );
      console.log(`saved ${await shotOf(page, '.stage__controls', path.join(outDir, `${tag}-focus-tab.png`))}`);

      // The notch itself is a button: Tab reaches it, Enter opens, Escape closes.
      await page.keyboard.press('Escape');
      await settled(page, 'closed').catch(() => {});
      await page.keyboard.down('Shift');
      await page.keyboard.press('Tab');
      await page.keyboard.up('Shift');
      const onNotch = await page.evaluate(() => document.activeElement?.getAttribute('data-part') === 'hit');
      const ring = await page.evaluate(() => {
        const style = getComputedStyle(document.activeElement);
        return `${style.outlineStyle} ${style.outlineWidth} ${style.outlineColor}`;
      });
      console.log(`saved ${await shotOf(page, '.mac', path.join(outDir, `${tag}-focus-notch.png`))}`);
      await page.keyboard.press('Enter');
      await settled(page, 'open:home').catch(() => {});
      const openedByKey = (await notchState(page)).state;
      const expanded = await page.evaluate(() => document.activeElement?.getAttribute('aria-expanded'));
      await page.keyboard.press('Escape');
      await settled(page, 'closed').catch(() => {});
      check(
        `${tag}: the notch is reachable by Tab, Enter opens it, Escape closes it`,
        onNotch && openedByKey === 'open:home' && expanded === 'true' && (await notchState(page)).state === 'closed',
        `focus on notch ${onNotch}, focus ring "${ring}", Enter -> ${openedByKey}, aria-expanded ${expanded}`,
      );
    }

    // ---- autoplay loop runs, and any interaction stops it
    await open(page, '');
    const auto0 = await page.evaluate(() => document.querySelector('[data-stage]').dataset.autoplay);
    await page.waitForFunction(() => document.getElementById('stage-notch').dataset.state === 'open:tray', { timeout: 9000 }).catch(() => {});
    const reachedSecond = (await notchState(page)).state === 'open:tray';
    await page.click('[role="tab"][data-face="system"]');
    await settled(page, 'open:system').catch(() => {});
    const auto1 = await page.evaluate(() => document.querySelector('[data-stage]').dataset.autoplay);
    await sleep(3400);
    const stayed = (await notchState(page)).state === 'open:system';
    check(
      `${tag}: the loop plays by itself and stops when a tab is picked`,
      auto0 === 'on' && reachedSecond && auto1 === 'off' && stayed,
      `autoplay ${auto0} -> ${auto1}, reached Tray ${reachedSecond}, stayed on System ${stayed}`,
    );
    await page.click('[data-autoplay-toggle]');
    await page.waitForFunction(() => document.getElementById('stage-notch').dataset.state === 'open:tools', { timeout: 6000 }).catch(() => {});
    check(`${tag}: the play button resumes the loop from the current face`, (await notchState(page)).state === 'open:tools');

    // ---- the loop and the small tickers stop when the stage is off screen or the tab is hidden
    const frozenFor = async (ms) => {
      const read = () =>
        page.evaluate(() => {
          const notch = document.getElementById('stage-notch');
          const bars = Array.from(notch.querySelectorAll('[data-bars] > i')).map((el) => el.style.transform);
          const progress = Array.from(document.querySelectorAll('.stab__progress')).map((el) => el.style.transform);
          return JSON.stringify([notch.dataset.state, bars, progress]);
        });
      const before = await read();
      await sleep(ms);
      return before === (await read());
    };
    await page.evaluate(() => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' }));
    await sleep(500);
    const offScreen = await page.evaluate(() => document.getElementById('stage-notch').dataset.suspended);
    const offScreenFrozen = await frozenFor(3200);
    await page.evaluate(() => document.querySelector('.mac').scrollIntoView({ block: 'center', behavior: 'instant' }));
    await sleep(500);
    const backOn = await page.evaluate(() => document.getElementById('stage-notch').dataset.suspended);
    const movesAgain = !(await frozenFor(600));
    check(
      `${tag}: off screen the loop and tickers pause, back in view they resume`,
      offScreen === 'true' && offScreenFrozen && backOn === 'false' && movesAgain,
      `suspended ${offScreen} -> ${backOn}, frozen off screen ${offScreenFrozen}, moving again ${movesAgain}`,
    );
    const other = await browser.newPage();
    await other.bringToFront();
    await sleep(400);
    const hidden = await page.evaluate(() => ({ hidden: document.hidden, suspended: document.getElementById('stage-notch').dataset.suspended }));
    const hiddenFrozen = await frozenFor(1500);
    await page.bringToFront();
    await other.close();
    await sleep(400);
    const shownAgain = await page.evaluate(() => ({ hidden: document.hidden, suspended: document.getElementById('stage-notch').dataset.suspended }));
    check(
      `${tag}: in a hidden tab everything pauses`,
      hidden.hidden && hidden.suspended === 'true' && hiddenFrozen && !shownAgain.hidden && shownAgain.suspended === 'false',
      `hidden ${hidden.hidden}, suspended ${hidden.suspended} -> ${shownAgain.suspended}, frozen ${hiddenFrozen}`,
    );
    // A stop that happens while the stage is off screen must stay a stop when it comes back.
    await page.waitForFunction(() => document.getElementById('stage-notch').dataset.state.startsWith('open:'), { timeout: 6000 }).catch(() => {});
    await page.evaluate(() => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' }));
    await sleep(500);
    await page.keyboard.press('Escape');
    await sleep(300);
    await page.evaluate(() => document.querySelector('.mac').scrollIntoView({ block: 'center', behavior: 'instant' }));
    await sleep(3400);
    const afterEscape = await page.evaluate(() => ({
      state: document.getElementById('stage-notch').dataset.state,
      autoplay: document.querySelector('[data-stage]').dataset.autoplay,
    }));
    check(
      `${tag}: Escape while the stage is off screen stops the loop for good`,
      afterEscape.state === 'closed' && afterEscape.autoplay === 'off',
      JSON.stringify(afterEscape),
    );

    // ---- live activities
    await open(page, '?face=home');
    console.log(`saved ${await shotOf(page, '#live', path.join(outDir, `${tag}-live-activities.png`))}`);
    const live = await page.evaluate(() =>
      Array.from(document.querySelectorAll('#live [data-notch]')).map((el) => `${el.dataset.right}:${el.dataset.state}`),
    );
    check(`${tag}: six closed notches with live activities`, live.length === 6 && live.every((l) => l.endsWith(':closed')), live.join(' '));

    // ---- reduced motion
    await open(page, '', { reduce: true });
    const reduced = await page.evaluate(() => ({
      autoplay: document.querySelector('[data-stage]').dataset.autoplay,
      toggleHidden: document.querySelector('[data-autoplay-toggle]').hidden,
      state: document.getElementById('stage-notch').dataset.state,
    }));
    await sleep(3200);
    const still = (await notchState(page)).state;
    check(
      `${tag} reduced motion: no loop, a still frame of Home`,
      reduced.autoplay === 'off' && reduced.toggleHidden && reduced.state === 'open:home' && still === 'open:home',
      JSON.stringify({ ...reduced, after3s: still }),
    );
    console.log(`saved ${await fullPage(page, path.join(outDir, `${tag}-reduced-page.png`))}`);
    const instant = [];
    for (const face of ['tray', 'calendar', 'ai']) {
      await page.click(`[role="tab"][data-face="${face}"]`);
      // No morph: the state and the picture must be there in the same task.
      const now = await notchState(page);
      instant.push(now.state === `open:${face}` && !now.busy);
      await sleep(60);
      console.log(`saved ${await shotOf(page, '.mac', path.join(outDir, `${tag}-reduced-face-${face}.png`))}`);
    }
    check(`${tag} reduced motion: faces switch at once from the tabs`, instant.every(Boolean));
    const frozen = await page.evaluate(async () => {
      const read = () =>
        Array.from(document.querySelectorAll('[data-bars] > i, [data-ring-part], [data-live="seek-fill"], .stab__progress'))
          .map((el) => getComputedStyle(el).transform)
          .join('|');
      const a = read();
      await new Promise((r) => setTimeout(r, 1200));
      return a === read();
    });
    check(`${tag} reduced motion: bars, rings and progress stand still`, frozen);
    await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'no-preference' }]);

    // ---- console and network
    check(`${tag}: no console errors or warnings`, consoleProblems.length === 0, consoleProblems.slice(0, 4).join(' | '));
    const hosts = [...requests].filter(Boolean);
    const external = hosts.filter((host) => host !== new URL(SITE_URL).host);
    check(`${tag}: every request stays on ${new URL(SITE_URL).host}`, external.length === 0, external.join(', '));
    problems.push(...consoleProblems);
    await page.close();
  }
} finally {
  await close();
}

const failed = results.filter((r) => !r.ok);
await writeFile(
  path.join(outDir, 'report.json'),
  JSON.stringify({ url: SITE_URL, at: new Date().toISOString(), results, console: problems }, null, 2),
);
console.log(`\n${results.length - failed.length} of ${results.length} checks passed. Report: ${rel(path.join(outDir, 'report.json'))}`);
if (failed.length) {
  console.log(`FAILED:\n${failed.map((f) => `  - ${f.name} ${f.detail}`).join('\n')}`);
  process.exitCode = 1;
}
