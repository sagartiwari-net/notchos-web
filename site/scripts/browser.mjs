// Shared launcher for the check scripts (look.mjs, shots.mjs, fps.mjs).
//
// Drives the Google Chrome that is already installed on this Mac through puppeteer-core.
// Nothing is downloaded. Every run uses a throwaway profile under $TMPDIR, so the owner's
// own Chrome profile is never read or written, and the profile is deleted on close.

import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

export const CHROME =
  process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

export const SITE_URL = process.env.SITE_URL ?? 'http://127.0.0.1:4312';

/**
 * @param {{ headless?: boolean, args?: string[] }} [options]
 */
export async function launch(options = {}) {
  if (!existsSync(CHROME)) {
    throw new Error(`Google Chrome not found at ${CHROME}. Set CHROME_PATH to its binary.`);
  }
  const profile = await mkdtemp(path.join(tmpdir(), 'notchos-site-chrome-'));
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: options.headless ?? true,
    userDataDir: profile,
    args: [
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-sync',
      '--disable-background-networking',
      // Never touch the login keychain (would raise a macOS prompt).
      '--use-mock-keychain',
      '--password-store=basic',
      '--hide-scrollbars',
      '--mute-audio',
      ...(options.args ?? []),
    ],
  });
  const close = async () => {
    try {
      await browser.close();
    } finally {
      await rm(profile, { recursive: true, force: true });
    }
  };
  return { browser, close, profile };
}

/** Fails early with a clear message when the dev or preview server is not running. */
export async function assertSiteUp(url = SITE_URL) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (error) {
    throw new Error(
      `The site is not answering at ${url} (${/** @type {Error} */ (error).message}). ` +
        'Start it first: `npm run dev`, or `npm run build && npm run preview`.',
    );
  }
}

export const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));
