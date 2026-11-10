// Step one morph of the stage notch frame by frame and save every frame.
// GSAP's own clock is taken off the ticker and advanced by hand (gsap.updateRoot), which is the
// same mechanism the promo clip export (S3) will use, so this also proves the notch can be
// rendered at any exact moment.
//
//   node scripts/frames.mjs --from closed --to open:tray [--fps 30] [--width 1440] [--dpr 1]
//                           [--out screenshots/frames] [--right music] [--left shelf]
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
const from = opt('from', 'closed');
const to = opt('to', 'open:home');
const fps = Number(opt('fps', 30));
const width = Number(opt('width', 1440));
const dpr = Number(opt('dpr', 1));
const outDir = path.resolve(opt('out', 'screenshots/frames'));
const right = opt('right');
const left = opt('left');

await assertSiteUp();
await mkdir(outDir, { recursive: true });
const { browser, close } = await launch();
try {
  const page = await browser.newPage();
  await page.setViewport({ width, height: width <= 500 ? 844 : 900, deviceScaleFactor: dpr });
  await page.goto(new URL('/?autoplay=0', SITE_URL).href, { waitUntil: 'networkidle0' });
  await sleep(300);

  const clip = await page.evaluate(
    (start, r, l) => {
      const el = document.getElementById('stage-notch');
      el.scrollIntoView({ block: 'center', behavior: 'instant' });
      const notch = window.NotchOS.get('stage-notch');
      notch.go({ state: start, right: r ?? null, left: l ?? null }, { animate: false });
      const spec = window.NotchOS.sizes[notch.mode];
      const anchor = el.getBoundingClientRect();
      const w = spec.open.w * notch.fit + 40;
      const h = Math.max(...Object.values(spec.faces)) * notch.fit + 24;
      return { x: anchor.left + window.scrollX - w / 2, y: anchor.top + window.scrollY, width: w, height: h };
    },
    from,
    right,
    left,
  );

  // Take GSAP off its own clock, start the morph, then advance by hand.
  const duration = await page.evaluate((target) => {
    const { gsap } = window.NotchOS;
    gsap.ticker.remove(gsap.updateRoot);
    window.__t = gsap.ticker.time;
    gsap.updateRoot(window.__t);
    const tween = window.NotchOS.get('stage-notch').setState(target);
    return tween ? tween.duration() : 0;
  }, to);

  const frames = Math.ceil(duration * fps) + 2;
  const name = `${from}--${to}`.replaceAll(':', '-');
  for (let i = 0; i <= frames; i++) {
    const state = await page.evaluate((dt) => {
      window.__t += dt;
      window.NotchOS.gsap.updateRoot(window.__t);
      const el = document.getElementById('stage-notch');
      return `${el.dataset.state}${el.dataset.busy ? ' busy' : ''}`;
    }, i === 0 ? 0 : 1 / fps);
    const file = path.join(outDir, `${name}-${String(i).padStart(2, '0')}.png`);
    await page.screenshot({ path: file, clip });
    console.log(`frame ${String(i).padStart(2, '0')} t=${(i / fps).toFixed(3)}s ${state}`);
  }
  console.log(`morph ${from} -> ${to}: ${duration}s, ${frames + 1} frames at ${fps} fps in ${path.relative(process.cwd(), outDir)}`);
} finally {
  await close();
}
