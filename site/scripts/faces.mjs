// Every face of the stage notch in one run, cropped to the island. A working aid for comparing
// the faces with the reference screenshots.
//
//   node scripts/faces.mjs [--width 1440] [--dpr 2] [--out screenshots/faces] [--reduce]
//
// Needs the dev or preview server on http://127.0.0.1:4312 (override with SITE_URL).

import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { SITE_URL, assertSiteUp, launch, sleep } from './browser.mjs';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const width = Number(opt('width', 1440));
const dpr = Number(opt('dpr', 2));
const outDir = path.resolve(opt('out', 'screenshots/faces'));
const reduce = args.includes('--reduce');

await assertSiteUp();
await mkdir(outDir, { recursive: true });
const { browser, close } = await launch();
try {
  const page = await browser.newPage();
  const problems = [];
  page.on('console', (msg) => {
    if (['error', 'warning'].includes(msg.type())) problems.push(`${msg.type()}: ${msg.text()}`);
  });
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
  await page.setViewport({
    width,
    height: width <= 500 ? 844 : 900,
    deviceScaleFactor: dpr,
    isMobile: width <= 500,
    hasTouch: width <= 500,
  });
  if (reduce) await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  await page.goto(new URL('/?autoplay=0', SITE_URL).href, { waitUntil: 'networkidle0' });
  await sleep(400);

  const shoot = async (name) => {
    const clip = await page.evaluate(() => {
      const el = document.getElementById('stage-notch');
      el.scrollIntoView({ block: 'center', behavior: 'instant' });
      const notch = window.NotchOS.get('stage-notch');
      const spec = window.NotchOS.sizes[notch.mode];
      const anchor = el.getBoundingClientRect();
      const open = notch.state.startsWith('open:');
      const w = (open ? spec.open.w : 460) * notch.fit;
      const h = (open ? spec.faces[notch.face] : 64) * notch.fit;
      const m = 14;
      return {
        x: Math.max(0, anchor.left + window.scrollX - w / 2 - m),
        y: Math.max(0, anchor.top + window.scrollY),
        width: w + m * 2,
        height: h + m,
      };
    });
    const file = path.join(outDir, `${width}-${name}.png`);
    await page.screenshot({ path: file, clip });
    return file;
  };

  const faces = await page.evaluate(() => [...window.NotchOS.faces]);
  for (const face of faces) {
    await page.evaluate((f) => window.NotchOS.get('stage-notch').setState(`open:${f}`, { animate: false }), face);
    await sleep(120);
    console.log(`saved ${path.relative(process.cwd(), await shoot(face))}`);
  }
  for (const [name, patch] of [
    ['closed', { state: 'closed', right: null, left: null }],
    ['closed-music-shelf', { state: 'closed', right: 'music', left: 'shelf' }],
    ['peek-timer', { state: 'peek', right: 'timer', left: null }],
  ]) {
    await page.evaluate((p) => window.NotchOS.get('stage-notch').go(p, { animate: false }), patch);
    await sleep(120);
    console.log(`saved ${path.relative(process.cwd(), await shoot(name))}`);
  }
  if (problems.length) console.log(`console problems:\n  ${problems.join('\n  ')}`);
  else console.log('console: no errors or warnings');
} finally {
  await close();
}
