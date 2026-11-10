// One screenshot of the running site, for looking at a single state while working.
//
//   node scripts/shot.mjs <out.png> [--path '/?face=tray'] [--width 1440] [--height 900]
//                         [--selector '#stage'] [--full] [--reduce] [--wait 900] [--dpr 1]
//
// Needs the dev or preview server on http://127.0.0.1:4312 (override with SITE_URL).

import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { SITE_URL, assertSiteUp, launch, sleep } from './browser.mjs';

const args = process.argv.slice(2);
const out = args[0];
if (!out || out.startsWith('--')) {
  console.error('usage: node scripts/shot.mjs <out.png> [--path /?face=tray] [--width 1440] [--selector #stage] [--full] [--reduce]');
  process.exit(2);
}
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const flag = (name) => args.includes(`--${name}`);

const width = Number(opt('width', 1440));
const height = Number(opt('height', width <= 500 ? 844 : 900));
const dpr = Number(opt('dpr', 1));
const url = new URL(opt('path', '/'), SITE_URL).href;

await assertSiteUp();
await mkdir(path.dirname(path.resolve(out)), { recursive: true });
const { browser, close } = await launch();
try {
  const page = await browser.newPage();
  const problems = [];
  page.on('console', (msg) => {
    if (['error', 'warning'].includes(msg.type())) problems.push(`${msg.type()}: ${msg.text()}`);
  });
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
  await page.setViewport({ width, height, deviceScaleFactor: dpr, isMobile: width <= 500, hasTouch: width <= 500 });
  if (flag('reduce')) await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  await page.goto(url, { waitUntil: 'networkidle0' });
  await sleep(Number(opt('wait', 900)));
  const selector = opt('selector');
  if (flag('island')) {
    // Crop to the island of one notch (default: the stage notch), with a margin around it.
    const id = opt('notch', 'stage-notch');
    const margin = Number(opt('margin', 24));
    const clip = await page.evaluate(
      async (notchId, m) => {
        const el = document.getElementById(notchId);
        el.scrollIntoView({ block: 'center', behavior: 'instant' });
        await new Promise((r) => setTimeout(r, 250));
        const notch = window.NotchOS.get(notchId);
        const spec = window.NotchOS.sizes[notch.mode];
        const anchor = el.getBoundingClientRect();
        const open = notch.state.startsWith('open:');
        const w = (open ? spec.open.w : 440) * notch.fit;
        const h = (open ? spec.faces[notch.face] : 70) * notch.fit;
        // puppeteer clips in page coordinates
        return {
          x: Math.max(0, anchor.left + window.scrollX - w / 2 - m),
          y: Math.max(0, anchor.top + window.scrollY),
          width: w + m * 2,
          height: h + m,
        };
      },
      id,
      margin,
    );
    await page.screenshot({ path: out, clip });
  } else if (selector) {
    const el = await page.$(selector);
    if (!el) throw new Error(`no element for ${selector}`);
    await el.evaluate((node) => node.scrollIntoView({ block: 'start', behavior: 'instant' }));
    await sleep(250);
    await el.screenshot({ path: out });
  } else {
    await page.screenshot({ path: out, fullPage: flag('full') });
  }
  const state = await page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-notch]')).map((el) => `${el.id}=${el.dataset.state}/${el.dataset.mode}`),
  );
  console.log(`saved ${out} (${width}x${height}@${dpr}) ${url}`);
  console.log(`notches: ${state.join(' ')}`);
  if (problems.length) console.log(`console problems:\n  ${problems.join('\n  ')}`);
} finally {
  await close();
}
