// S1 step 5: look at the three reference sites for the level of polish expected.
// Screenshots go to screenshots/reference-sites/ (git-ignored). They are for looking only:
// no artwork, text or names from these sites are used on the NotchOS page.
//
//   node scripts/look.mjs

import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, sleep } from './browser.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'screenshots', 'reference-sites');

const sites = [
  ['getnotchnook', 'https://getnotchnook.com/'],
  ['notchy', 'https://notchy.dev/'],
  ['dynamicnotch', 'https://dynamicnotch.tech/'],
];

await mkdir(outDir, { recursive: true });
const { browser, close } = await launch();
try {
  for (const [name, url] of sites) {
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
    try {
      const res = await page.goto(url, { waitUntil: 'networkidle2', timeout: 45000 });
      await sleep(2500);
      const height = await page.evaluate(() => document.documentElement.scrollHeight);
      console.log(`${name}: HTTP ${res?.status()} · title "${await page.title()}" · page height ${height}px`);
      // The fold, then a few steps down the page.
      const steps = [0, 900, 1800, 3000, 4500];
      for (const [i, y] of steps.entries()) {
        if (y > height) break;
        await page.evaluate((top) => window.scrollTo({ top, behavior: 'instant' }), y);
        await sleep(900);
        const file = path.join(outDir, `${name}-1440-${i}.png`);
        await page.screenshot({ path: file });
        console.log(`  saved ${path.relative(root, file)}`);
      }
      await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
      await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
      await sleep(1200);
      const file = path.join(outDir, `${name}-390-0.png`);
      await page.screenshot({ path: file });
      console.log(`  saved ${path.relative(root, file)}`);
    } catch (error) {
      console.log(`${name}: could not load (${/** @type {Error} */ (error).message})`);
    } finally {
      await page.close();
    }
  }
} finally {
  await close();
}
