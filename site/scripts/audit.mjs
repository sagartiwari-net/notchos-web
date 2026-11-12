// Light-theme audit. For every page type, at desktop and phone width:
//
//   1. screenshots, one per screenful, into screenshots/audit/
//   2. the contrast of every run of visible text against what is really painted behind it
//   3. cards, badges and inputs that cannot be told apart from the page behind them
//   4. sideways scroll, console errors, failed requests
//   5. the notch demo: the drawn Mac and the live-activity strips must be pixel-identical to the
//      app's own dark design (the same surfaces with the app palette forced on), for every face
//   6. the nav: nothing runs under the facts strip at any window width from 320 to 1920
//
//   npm run build && npm run preview          (or npm run dev)
//   npm run audit                             the page types listed in PAGES
//   npm run audit -- --only home,vs           pages whose name starts with one of these
//   npm run audit -- --sitemap                every URL in dist/sitemap-0.xml, desktop only
//   npm run audit -- --views 1024x768,820x1180   other window sizes than 1440 and 390
//   npm run audit -- --no-notch               skip check 5      (--no-nav skips check 6)
//   npm run audit -- --no-shots               do not write the screenshots
//
// Another build than site/dist on 4312: SITE_URL=http://127.0.0.1:4313 AUDIT_DIST=/path/dist
// AUDIT_OUT=/path/for/screenshots node scripts/audit.mjs
//
// How the background is measured: each page is painted twice, as it is and with the glyphs
// made transparent (-webkit-text-fill-color, which leaves `color` and everything drawn with
// currentColor alone). The second picture is what really lies under each run of text —
// gradients, layered alpha and the drawn wallpaper included. No guessing from the DOM.
//
// Exit code 1 when anything fails.

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { inflateSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SITE_URL, assertSiteUp, launch, sleep } from './browser.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// AUDIT_OUT / AUDIT_DIST: audit a build that lives somewhere else (a copy served on another port).
const outDir = process.env.AUDIT_OUT ?? path.join(root, 'screenshots', 'audit');
const distDir = process.env.AUDIT_DIST ?? path.join(root, 'dist');
const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const flag = (name) => args.includes(`--${name}`);

const VIEWS = [
  { name: '1440', width: 1440, height: 900, dpr: 1, mobile: false },
  { name: '390', width: 390, height: 844, dpr: 2, mobile: true },
];

/**
 * `first: [index, prefix]` means: the first link on `index` whose href starts with `prefix`.
 * `reveal: 'ok' | 'error'` shows what the page keeps hidden until something happens — the
 * checkout panel, a coupon message, the status line under a form — in that state.
 */
const PAGES = [
  { name: 'home', path: '/?face=home' },
  { name: 'home-checkout', path: '/?state=closed', reveal: 'ok' },
  { name: 'home-checkout-err', path: '/?state=closed', reveal: 'error' },
  { name: 'trial-sent', path: '/trial', reveal: 'ok' },
  { name: 'trial-error', path: '/trial', reveal: 'error' },
  { name: 'discount-coupon', path: '/discount', reveal: 'ok' },
  { name: 'download', path: '/download' },
  { name: 'trial', path: '/trial' },
  { name: 'recover', path: '/recover' },
  { name: 'discount', path: '/discount' },
  { name: 'thanks', path: '/thanks' },
  { name: 'terms', path: '/terms' },
  { name: 'privacy', path: '/privacy' },
  { name: 'refund', path: '/refund' },
  { name: 'blog', path: '/blog' },
  { name: 'blog-post', first: ['/blog', '/blog/'] },
  { name: 'alternatives', path: '/alternatives' },
  { name: 'alternatives-post', first: ['/alternatives', '/alternatives/'] },
  { name: 'compare', path: '/compare' },
  { name: 'compare-post', first: ['/compare', '/compare/'] },
  { name: 'best', path: '/best-mac-notch-apps' },
  { name: 'vs', path: '/vs' },
  { name: 'vs-stats', path: '/vs/stats' },
  { name: 'vs-alcove', path: '/vs/alcove' },
  { name: 'vs-raycast', path: '/vs/raycast' },
];

/** Things that must read as a surface of their own: a visible edge or a visible fill. */
const SURFACES = [
  '.feat-card',
  '.feat-mark',
  '.price-card',
  '.price-card__badge',
  '.price-checkout',
  '.steps__item',
  '.steps__n',
  '.faq__item',
  '.postlist__link',
  '.lcard',
  '.vs-cat',
  '.vs-card',
  '.vs-buy',
  '.vs-link-box',
  '.vs-pill',
  '.vs-glance__badge',
  '.content__cta',
  '.stage__tabs',
  '.stage__play',
  '.tag',
  '.btn',
  '.vs-btn',
  '.discount-share',
  '.discount-result',
  '.deal__step',
  '.deal__meter',
  '.deal__net',
  '.deal__code',
  '.price-checkout__key',
  'kbd',
  'input:not([type=hidden])',
  'textarea',
  'select',
].join(',');

// WCAG 2 contrast: 4.5 for body text, 3 for large text (24px, or 18.66px bold).
const NEED_TEXT = 4.5;
const NEED_LARGE = 3;
// Inside the drawn Mac the type follows the app (NotchColor textTertiary is white at 35%), and
// check 5 pins it to the app's design pixel for pixel. This floor only catches dark on dark.
const NEED_NOTCH = 2;
// A surface is there when its edge or its fill differs from what is outside it by this much.
const NEED_EDGE = 1.1;
const NEED_FILL = 1.045;
// A field you type into needs a real outline.
const NEED_FIELD = 1.3;

// Everything that sticks while the page scrolls is laid flat: the page is painted one screen at
// a time, and a stuck box would be painted in every one of them, away from where it was measured.
const NO_STICKY_CSS = '.nav,.faq-side,.deal__intro{position:static!important}';
const NO_TEXT_CSS =
  '*,*::before,*::after{-webkit-text-fill-color:transparent!important;text-shadow:none!important}' +
  '::placeholder{-webkit-text-fill-color:transparent!important}';

// ------------------------------------------------------------------ pixels

/** 8-bit RGB / RGBA, not interlaced: what Chrome writes. */
function decodePng(buf) {
  let pos = 8;
  let width = 0;
  let height = 0;
  let depth = 0;
  let type = 0;
  let interlace = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const name = buf.toString('latin1', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (name === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      depth = data[8];
      type = data[9];
      interlace = data[12];
    } else if (name === 'IDAT') idat.push(data);
    else if (name === 'IEND') break;
    pos += 12 + len;
  }
  if (depth !== 8 || interlace !== 0 || (type !== 2 && type !== 6)) {
    throw new Error(`unexpected PNG (depth ${depth}, colour type ${type}, interlace ${interlace})`);
  }
  const bpp = type === 6 ? 4 : 3;
  const stride = width * bpp;
  const raw = inflateSync(Buffer.concat(idat));
  const out = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = y * (stride + 1) + 1;
    const cur = y * stride;
    const up = cur - stride;
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? out[cur + i - bpp] : 0;
      const b = y > 0 ? out[up + i] : 0;
      const c = i >= bpp && y > 0 ? out[up + i - bpp] : 0;
      let v = raw[line + i];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out[cur + i] = v & 255;
    }
  }
  return { width, height, bpp, data: out };
}

const lin = (c) => {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};
const lum = (c) => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
const contrast = (a, b) => {
  const la = lum(a);
  const lb = lum(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
};
const blend = (fg, alpha, bg) => [0, 1, 2].map((i) => fg[i] * alpha + bg[i] * (1 - alpha));
const hex = (c) => `#${c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;

const image = (tile) => (tile.img ??= decodePng(tile.png));

/** The tile that holds a rect given in page coordinates (CSS px). */
function tileFor(tiles, view, y, h) {
  for (const tile of tiles) if (y >= tile.y && y + h <= tile.y + view.height) return tile;
  const mid = y + h / 2;
  for (const tile of tiles) if (mid >= tile.y && mid < tile.y + view.height) return tile;
  return tiles[tiles.length - 1];
}

/** One pixel at a page coordinate, or null when it is off the picture. */
function pixelAt(tiles, view, x, y) {
  const tile = tileFor(tiles, view, y, 0);
  const img = image(tile);
  const px = Math.floor(x * view.dpr);
  const py = Math.floor((y - tile.y) * view.dpr);
  if (px < 0 || py < 0 || px >= img.width || py >= img.height) return null;
  const i = (py * img.width + px) * img.bpp;
  return [img.data[i], img.data[i + 1], img.data[i + 2]];
}

/** Device-pixel box of a page rect inside its tile. */
function boxIn(tiles, view, [x, y, w, h]) {
  const tile = tileFor(tiles, view, y, h);
  const img = image(tile);
  const x0 = Math.max(0, Math.round(x * view.dpr));
  const x1 = Math.min(img.width, Math.round((x + w) * view.dpr));
  const y0 = Math.max(0, Math.round((y - tile.y) * view.dpr));
  const y1 = Math.min(img.height, Math.round((y + h - tile.y) * view.dpr));
  if (x1 - x0 < 1 || y1 - y0 < 1) return null;
  const step = Math.max(1, Math.floor(Math.sqrt(((x1 - x0) * (y1 - y0)) / 6000)));
  return { index: tiles.indexOf(tile), img, x0, x1, y0, y1, step };
}

/** What is painted behind a run of text: the 10th, 50th and 90th percentile by luminance. */
function background(noText, view, rect) {
  const box = boxIn(noText, view, rect);
  if (!box) return null;
  const { img, x0, x1, y0, y1, step } = box;
  const found = [];
  for (let y = y0; y < y1; y += step) {
    for (let x = x0; x < x1; x += step) {
      const i = (y * img.width + x) * img.bpp;
      const c = [img.data[i], img.data[i + 1], img.data[i + 2]];
      found.push([lum(c), c]);
    }
  }
  found.sort((a, b) => a[0] - b[0]);
  const at = (q) => found[Math.min(found.length - 1, Math.floor(found.length * q))][1];
  return { p10: at(0.1), p50: at(0.5), p90: at(0.9) };
}

/** How much the picture changes when the glyphs go: 0 means nothing was painted here. */
function inked(withText, noText, view, rect) {
  const box = boxIn(withText, view, rect);
  if (!box) return 0;
  const other = image(noText[box.index]);
  const { img, x0, x1, y0, y1, step } = box;
  let most = 0;
  for (let y = y0; y < y1; y += step) {
    for (let x = x0; x < x1; x += step) {
      const i = (y * img.width + x) * img.bpp;
      const j = (y * other.width + x) * other.bpp;
      const d = Math.max(
        Math.abs(img.data[i] - other.data[j]),
        Math.abs(img.data[i + 1] - other.data[j + 1]),
        Math.abs(img.data[i + 2] - other.data[j + 2]),
      );
      if (d > most) most = d;
    }
  }
  return most;
}

/** Edge and fill of a surface against what is just outside it, the best of its four sides. */
function surfaceContrast(noText, view, [x, y, w, h]) {
  const deep = Math.min(4.5, h / 2, w / 2);
  const sides = [
    (t) => [x + w / 2, y + t],
    (t) => [x + w / 2, y + h - t],
    (t) => [x + t, y + h / 2],
    (t) => [x + w - t, y + h / 2],
  ];
  let edge = 1;
  let fill = 1;
  for (const side of sides) {
    const outside = pixelAt(noText, view, ...side(-2.5));
    const inside = pixelAt(noText, view, ...side(deep));
    if (!outside || !inside) continue;
    fill = Math.max(fill, contrast(inside, outside));
    for (const t of [0.5, 1.5]) {
      const line = pixelAt(noText, view, ...side(t));
      if (line) edge = Math.max(edge, contrast(line, outside));
    }
  }
  return { edge, fill };
}

// ------------------------------------------------------------- in the page

/** Runs in the page. Everything the audit needs to know, in page coordinates. */
function collect(surfaceSelector) {
  for (const d of document.querySelectorAll('details')) d.open = true;

  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const seen = new Map();
  const rgba = (str) => {
    if (seen.has(str)) return seen.get(str);
    const m = str.match(/^rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)$/);
    let v;
    if (m) v = [+m[1], +m[2], +m[3], m[4] === undefined ? 1 : +m[4]];
    else {
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = str;
      ctx.fillRect(0, 0, 1, 1);
      const d = ctx.getImageData(0, 0, 1, 1).data;
      v = [d[0], d[1], d[2], d[3] / 255];
    }
    seen.set(str, v);
    return v;
  };

  const opacities = new WeakMap();
  const opacityOf = (el) => {
    if (!el) return 1;
    if (opacities.has(el)) return opacities.get(el);
    const v = parseFloat(getComputedStyle(el).opacity) * opacityOf(el.parentElement);
    opacities.set(el, v);
    return v;
  };

  // The box an element's content is clipped to by itself and its ancestors (viewport coords).
  const clips = new WeakMap();
  const clipOf = (el) => {
    if (!el) return [-1e9, -1e9, 1e9, 1e9];
    if (clips.has(el)) return clips.get(el);
    let [l, t, r, b] = clipOf(el.parentElement);
    const cs = getComputedStyle(el);
    if (cs.overflowX !== 'visible' || cs.overflowY !== 'visible') {
      const box = el.getBoundingClientRect();
      if (cs.overflowX !== 'visible') {
        l = Math.max(l, box.left);
        r = Math.min(r, box.right);
      }
      if (cs.overflowY !== 'visible') {
        t = Math.max(t, box.top);
        b = Math.min(b, box.bottom);
      }
    }
    const v = [l, t, r, b];
    clips.set(el, v);
    return v;
  };

  const pathOf = (el) => {
    const parts = [];
    for (let p = el; p && p !== document.body && parts.length < 4; p = p.parentElement) {
      let s = p.tagName.toLowerCase();
      if (p.id) s += `#${p.id}`;
      else if (p.classList.length) s += `.${[...p.classList].slice(0, 2).join('.')}`;
      parts.unshift(s);
    }
    return parts.join(' > ');
  };
  const zoneOf = (el) => (el.closest('.mac, .lcard__screen, .notch') ? 'notch' : 'page');
  const sx = window.scrollX;
  const sy = window.scrollY;
  const within = (r, clip) => {
    const l = Math.max(r.left, clip[0]);
    const t = Math.max(r.top, clip[1]);
    const rr = Math.min(r.right, clip[2]);
    const b = Math.min(r.bottom, clip[3]);
    return rr - l >= 2 && b - t >= 2 ? [l + sx, t + sy, rr - l, b - t] : null;
  };

  const texts = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const str = node.nodeValue.replace(/\s+/g, ' ').trim();
    if (!str) continue;
    const el = node.parentElement;
    if (!el || el.closest('script, style, noscript, template, svg, .sr-only, textarea')) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility !== 'visible') continue;
    const opacity = opacityOf(el);
    if (opacity < 0.05) continue;
    range.selectNodeContents(node);
    const clip = clipOf(el);
    const rects = [];
    for (const r of range.getClientRects()) {
      const box = within(r, clip);
      if (box) rects.push(box);
    }
    if (!rects.length) continue;
    const box = el.getBoundingClientRect();
    const scale = el.offsetWidth ? box.width / el.offsetWidth : 1;
    texts.push({
      kind: 'text',
      text: str.slice(0, 70),
      path: pathOf(el),
      zone: zoneOf(el),
      rects: rects.slice(0, 6),
      color: rgba(cs.webkitTextFillColor || cs.color),
      opacity,
      size: parseFloat(cs.fontSize) * scale,
      weight: parseInt(cs.fontWeight, 10) || 400,
      disabled: !!el.closest('button:disabled, [aria-disabled="true"]'),
    });
  }

  // What is typed into a field, or its placeholder, is not a text node of the document.
  for (const el of document.querySelectorAll('input:not([type=hidden]), textarea, select')) {
    const cs = getComputedStyle(el);
    if (cs.visibility !== 'visible' || el.closest('.sr-only')) continue;
    const opacity = opacityOf(el);
    const box = el.getBoundingClientRect();
    if (opacity < 0.05 || box.width < 8 || box.height < 8 || box.right <= 0) continue;
    const pad = (side) => parseFloat(cs[`padding${side}`]) + parseFloat(cs[`border${side}Width`]);
    const inner = {
      left: box.left + pad('Left'),
      top: box.top + pad('Top'),
      right: box.right - pad('Right'),
      bottom: box.bottom - pad('Bottom'),
    };
    const rect = within(inner, clipOf(el.parentElement));
    if (!rect) continue;
    const empty = !el.value && !!el.placeholder;
    texts.push({
      kind: empty ? 'placeholder' : 'field',
      text: (empty ? el.placeholder : el.value || el.type).slice(0, 70),
      path: pathOf(el),
      zone: zoneOf(el),
      rects: [rect],
      color: rgba(empty ? getComputedStyle(el, '::placeholder').color : cs.color),
      opacity,
      size: parseFloat(cs.fontSize),
      weight: parseInt(cs.fontWeight, 10) || 400,
      disabled: el.disabled,
    });
  }

  const surfaces = [];
  for (const el of document.querySelectorAll(surfaceSelector)) {
    if (zoneOf(el) === 'notch' || el.closest('.sr-only')) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility !== 'visible' || opacityOf(el) < 0.05) continue;
    const box = el.getBoundingClientRect();
    if (box.width < 8 || box.height < 8 || box.right <= 0) continue;
    const rect = within(box, clipOf(el.parentElement));
    if (!rect || rect[2] < box.width - 1 || rect[3] < box.height - 1) continue;
    surfaces.push({
      path: pathOf(el),
      field: el.matches('input, textarea, select'),
      rect: [box.left + sx, box.top + sy, box.width, box.height],
    });
  }

  const doc = document.documentElement;
  return {
    texts,
    surfaces,
    doc: { w: doc.scrollWidth, h: doc.scrollHeight, client: doc.clientWidth },
  };
}

/** Runs in the page. Un-hides the parts that wait for an event and puts them in one state. */
function reveal(kind) {
  const sample = 'Sample message: 20% off, invoice INV-0042, key NOS-AAAA-BBBB-CCCC.';
  for (const el of document.querySelectorAll('main [hidden]')) {
    if (el.closest('.mac, .lcard__screen')) continue;
    el.hidden = false;
    if (!el.textContent.trim() && !el.children.length) el.textContent = sample;
  }
  for (const el of document.querySelectorAll('main [role="status"], main [data-checkout-status], main [data-coupon-msg]')) {
    if (!el.textContent.trim()) el.textContent = sample;
    el.dataset.kind = kind; // .simple__status
    el.dataset.ok = kind === 'ok' ? '1' : '0'; // .price-checkout__status
  }
}

// ---------------------------------------------------------------- driving

/** The page from top to bottom, one viewport at a time. */
async function paint(page, view, docHeight) {
  const tiles = [];
  for (let top = 0; top < docHeight; top += view.height) {
    const y = await page.evaluate((to) => {
      window.scrollTo({ top: to, behavior: 'instant' });
      return window.scrollY;
    }, top);
    await sleep(70);
    tiles.push({ y, png: Buffer.from(await page.screenshot({ captureBeyondViewport: false })), img: null });
  }
  return tiles;
}

async function ready(page) {
  if (await page.$('#stage-notch')) {
    await page.waitForFunction(() => {
      const el = document.getElementById('stage-notch');
      return el.dataset.ready === 'true' && !el.dataset.busy;
    });
    await sleep(700);
  } else {
    await sleep(200);
  }
}

function judge(view, data, withText, noText) {
  const fails = [];
  const hidden = [];
  let checked = 0;
  for (const t of data.texts) {
    let worst = null;
    for (const rect of t.rects) {
      const bg = background(noText, view, rect);
      if (!bg) continue;
      const alpha = t.color[3] * t.opacity;
      let ratio = Infinity;
      for (const c of [bg.p10, bg.p50, bg.p90]) ratio = Math.min(ratio, contrast(blend(t.color, alpha, c), c));
      if (!worst || ratio < worst.ratio) {
        worst = { ratio, bg: bg.p50, fg: blend(t.color, alpha, bg.p50), ink: inked(withText, noText, view, rect), rect };
      }
    }
    if (!worst) continue;
    checked++;
    const large = t.size >= 24 || (t.size >= 18.66 && t.weight >= 700);
    const need = t.zone === 'notch' ? NEED_NOTCH : large ? NEED_LARGE : NEED_TEXT;
    const row = {
      ratio: +worst.ratio.toFixed(2),
      need,
      text: t.text,
      path: t.path,
      kind: t.kind,
      zone: t.zone,
      fg: hex(worst.fg),
      bg: hex(worst.bg),
      size: +t.size.toFixed(1),
      weight: t.weight,
      at: worst.rect.map(Math.round),
    };
    // Text the model says is readable, but which left no mark on the picture: something lies
    // over it or it is clipped away. Not a contrast problem; listed so it can be looked at.
    if (t.kind === 'text' && worst.ink < 10 && worst.ratio >= 1.25) hidden.push(row);
    else if (t.disabled) continue;
    else if (worst.ratio < need) fails.push(row);
  }

  const lost = [];
  for (const s of data.surfaces) {
    const { edge, fill } = surfaceContrast(noText, view, s.rect);
    const ok = s.field ? edge >= NEED_FIELD || fill >= NEED_FIELD : edge >= NEED_EDGE || fill >= NEED_FILL;
    if (!ok) lost.push({ path: s.path, edge: +edge.toFixed(3), fill: +fill.toFixed(3), field: s.field, at: s.rect.map(Math.round) });
  }
  return { checked, fails, hidden, lost, surfaces: data.surfaces.length };
}

/** Same class of problem reported once, with a count. */
function grouped(rows, key) {
  const groups = new Map();
  for (const row of rows) {
    const k = key(row);
    const g = groups.get(k);
    if (g) g.count++;
    else groups.set(k, { ...row, count: 1 });
  }
  return [...groups.values()];
}

async function auditPage(page, view, name, url, save, state) {
  const noise = [];
  const onConsole = (msg) => {
    if (msg.type() === 'error') noise.push(`console: ${msg.text()}`);
  };
  const onError = (error) => noise.push(`pageerror: ${error.message}`);
  const onFailed = (request) => noise.push(`failed: ${request.url()} ${request.failure()?.errorText ?? ''}`);
  const onResponse = (response) => {
    if (response.status() >= 400) noise.push(`HTTP ${response.status()}: ${response.url()}`);
  };
  page.on('console', onConsole);
  page.on('pageerror', onError);
  page.on('requestfailed', onFailed);
  page.on('response', onResponse);
  try {
    await page.goto(url, { waitUntil: 'networkidle0' });
    await ready(page);
    if (state) await page.evaluate(reveal, state);
    await page.addStyleTag({ content: NO_STICKY_CSS });
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
    const data = await page.evaluate(collect, SURFACES);
    const withText = await paint(page, view, data.doc.h);
    const style = await page.addStyleTag({ content: NO_TEXT_CSS });
    const noText = await paint(page, view, data.doc.h);
    await style.evaluate((node) => node.remove());
    if (save) {
      for (const [i, tile] of withText.entries()) {
        await writeFile(path.join(outDir, `${name}-${view.name}-${String(i).padStart(2, '0')}.png`), tile.png);
      }
    }
    const verdict = judge(view, data, withText, noText);
    return {
      page: name,
      view: view.name,
      url,
      height: data.doc.h,
      screens: withText.length,
      sideways: data.doc.w > data.doc.client ? `scrollWidth ${data.doc.w} > ${data.doc.client}` : '',
      noise,
      ...verdict,
    };
  } finally {
    page.off('console', onConsole);
    page.off('pageerror', onError);
    page.off('requestfailed', onFailed);
    page.off('response', onResponse);
  }
}

/**
 * Share of pixels that differ between two pictures of the same size. `again` is a second
 * picture of `a`, taken after `b`: a pixel that moved between the two (the battery bolt
 * breathes, a second ticks over) is motion, not colour, and is left out.
 */
function differing(a, b, again) {
  if (a.width !== b.width || a.height !== b.height) return { differs: 100, moved: 0 };
  const far = (p, i, q, j) =>
    Math.abs(p.data[i] - q.data[j]) > 3 ||
    Math.abs(p.data[i + 1] - q.data[j + 1]) > 3 ||
    Math.abs(p.data[i + 2] - q.data[j + 2]) > 3;
  let diff = 0;
  let moved = 0;
  const total = a.width * a.height;
  for (let n = 0; n < total; n++) {
    const i = n * a.bpp;
    if (far(a, i, again, n * again.bpp)) moved++;
    else if (far(a, i, b, n * b.bpp)) diff++;
  }
  // Percent of the picture. `moved` is reported too: a picture that will not hold still cannot
  // vouch for anything, so a large share of motion fails the check instead of hiding in it.
  return { differs: +((diff / total) * 100).toFixed(3), moved: +((moved / total) * 100).toFixed(3) };
}

/**
 * The drawn Mac and the live-activity strips are the app's own dark design. Paint them as the
 * page styles them, and again with the app palette forced onto them; nothing may differ.
 *
 * The app palette is read from the stylesheet itself: the `:root` rule that tokens.css's
 * `@theme` block becomes. It is set inline on the drawn surfaces for the second picture, so the
 * reference does not depend on the rule under test (the hand-back in compare-theme.css), and
 * the layout of the page around them stays exactly as it is.
 */
async function auditNotch(page, view, save) {
  const rows = [];
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  const appPalette = (on) =>
    page.evaluate((v) => {
      const palette = {};
      const walk = (rules) => {
        for (const rule of rules) {
          if (rule instanceof CSSStyleRule) {
            if (/(^|,)\s*:root\b/.test(rule.selectorText) && !rule.selectorText.includes('theme-compare')) {
              for (const name of rule.style) {
                if (name.startsWith('--color-')) palette[name] = rule.style.getPropertyValue(name).trim();
              }
            }
          } else if (rule.cssRules) walk(rule.cssRules);
        }
      };
      for (const sheet of document.styleSheets) {
        try {
          walk(sheet.cssRules);
        } catch {
          /* a sheet from another origin: not ours */
        }
      }
      for (const el of document.querySelectorAll('.mac, .lcard__screen')) {
        for (const [name, value] of Object.entries(palette)) {
          if (v) el.style.setProperty(name, value);
          else el.style.removeProperty(name);
        }
      }
      return Object.keys(palette).length;
    }, on);
  const pair = async (handle, file) => {
    await handle.evaluate((node) => node.scrollIntoView({ block: 'center', behavior: 'instant' }));
    await sleep(120);
    const light = Buffer.from(await handle.screenshot({ captureBeyondViewport: false }));
    const names = await appPalette(true);
    if (names < 10) throw new Error(`only ${names} --color-* tokens found on :root; is tokens.css in the build?`);
    await sleep(120);
    const dark = Buffer.from(await handle.screenshot({ captureBeyondViewport: false }));
    await appPalette(false);
    await sleep(120);
    const again = Buffer.from(await handle.screenshot({ captureBeyondViewport: false }));
    if (save) await writeFile(path.join(outDir, file), light);
    return differing(decodePng(light), decodePng(dark), decodePng(again));
  };

  await page.goto(new URL('/?face=home', SITE_URL).href, { waitUntil: 'networkidle0' });
  await ready(page);
  const faces = await page.evaluate(() => [...window.NotchOS.faces]);
  const states = [
    ['closed', '?state=closed'],
    ['closed-chips', '?state=closed&right=music&left=shelf'],
    ['peek', '?state=peek&right=timer'],
    ...faces.map((face) => [`face-${face}`, `?face=${face}`]),
  ];
  for (const [label, query] of states) {
    await page.goto(new URL(`/${query}`, SITE_URL).href, { waitUntil: 'networkidle0' });
    await ready(page);
    const screen = await page.$('.mac__screen');
    rows.push({ view: view.name, what: label, ...(await pair(screen, `notch-${view.name}-${label}.png`)) });
  }

  await page.goto(new URL('/?state=closed', SITE_URL).href, { waitUntil: 'networkidle0' });
  await ready(page);
  const strips = await page.$$('.lcard__screen');
  for (const [i, strip] of strips.entries()) {
    // The picture beside the FAQ is one of these too, and it is not shown on a narrow window.
    if (!(await strip.boundingBox())) continue;
    rows.push({ view: view.name, what: `live-${i}`, ...(await pair(strip, `notch-${view.name}-live-${i}.png`)) });
  }
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'no-preference' }]);
  return rows;
}

/**
 * The facts strip hangs in the middle of the nav. At no window width may the brand, a link or
 * the button run under it, into each other, or out of the row.
 */
async function auditNav(page) {
  const view = page.viewport();
  await page.goto(new URL('/download', SITE_URL).href, { waitUntil: 'networkidle0' });
  const clashes = [];
  for (let width = 320; width <= 1920; width += 20) {
    await page.setViewport({ ...view, width, height: 700 });
    const found = await page.evaluate(() => {
      const box = (el) => {
        const b = el.getBoundingClientRect();
        return { l: b.left, r: b.right, t: b.top, b: b.bottom };
      };
      const meet = (a, b, air) => a.l < b.r + air && b.l < a.r + air && a.t < b.b && b.t < a.b;
      const strip = box(document.querySelector('.factnotch'));
      const row = box(document.querySelector('.nav__row'));
      const items = [...document.querySelectorAll('.nav .brand, .nav .nav__link, .nav .nav__cta')]
        .filter((el) => getComputedStyle(el).display !== 'none')
        .map((el) => ({ name: el.textContent.trim(), ...box(el) }));
      const out = [];
      for (const item of items) {
        if (meet(item, strip, 6)) out.push(`"${item.name}" under the facts strip`);
        if (item.l < row.l - 0.5 || item.r > row.r + 0.5) out.push(`"${item.name}" outside the row`);
      }
      for (let i = 1; i < items.length; i++) {
        if (meet(items[i - 1], items[i], -0.5)) out.push(`"${items[i - 1].name}" overlaps "${items[i].name}"`);
      }
      return out;
    });
    if (found.length) clashes.push({ width, found });
  }
  await page.setViewport(view);
  return clashes;
}

// -------------------------------------------------------------------- run

await assertSiteUp();
const save = !flag('no-shots');
if (save) {
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
}

let pages = PAGES;
let views = VIEWS;
if (flag('sitemap')) {
  const xml = await readFile(path.join(distDir, 'sitemap-0.xml'), 'utf8');
  pages = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => {
    const p = new URL(m[1]).pathname.replace(/\/$/, '') || '/';
    return { name: p === '/' ? 'home' : p.slice(1).replaceAll('/', '-'), path: p === '/' ? '/?face=home' : p };
  });
  views = VIEWS.slice(0, 1);
}
const only = opt('only');
if (only) {
  const wanted = only.split(',');
  pages = pages.filter((p) => wanted.some((w) => p.name.startsWith(w)));
}
const width = opt('width');
if (width) views = views.filter((v) => width.split(',').includes(v.name));
// --views 1024x768,820x1180: other window sizes, for the widths between desktop and phone.
const custom = opt('views');
if (custom) {
  views = custom.split(',').map((size) => {
    const [w, h] = size.split('x').map(Number);
    return { name: String(w), width: w, height: h, dpr: 1, mobile: w <= 500 };
  });
}

const { browser, close } = await launch();
const report = { url: SITE_URL, at: new Date().toISOString(), pages: [], notch: [], nav: [] };
let bad = 0;
try {
  for (const view of views) {
    const page = await browser.newPage();
    await page.setCacheEnabled(false);
    await page.setViewport({
      width: view.width,
      height: view.height,
      deviceScaleFactor: view.dpr,
      isMobile: view.mobile,
      hasTouch: view.mobile,
    });
    console.log(`\n=== ${view.width}px wide (dpr ${view.dpr}) ===`);
    for (const target of pages) {
      let url = target.path && new URL(target.path, SITE_URL).href;
      if (target.first) {
        await page.goto(new URL(target.first[0], SITE_URL).href, { waitUntil: 'networkidle0' });
        const href = await page.evaluate(
          (prefix) => document.querySelector(`main a[href^="${prefix}"]`)?.getAttribute('href'),
          target.first[1],
        );
        if (!href) {
          console.log(`SKIP  ${target.name}: no link starting with ${target.first[1]} on ${target.first[0]}`);
          continue;
        }
        url = new URL(href, SITE_URL).href;
      }
      // A page that will not load (the build was replaced under a long run, a detached frame)
      // gets one more try; after that it is a failed page, not the end of the run.
      let result;
      for (let attempt = 1; !result; attempt++) {
        try {
          result = await auditPage(page, view, target.name, url, save && !flag('sitemap'), target.reveal);
        } catch (error) {
          if (attempt === 2) {
            console.log(`FAIL  ${target.name.padEnd(18)} could not be audited: ${/** @type {Error} */ (error).message}`);
            bad++;
            break;
          }
          await sleep(1500);
        }
      }
      if (!result) continue;
      report.pages.push(result);
      const problems =
        result.fails.length + result.lost.length + (result.sideways ? 1 : 0) + result.noise.length;
      bad += problems;
      console.log(
        `${problems ? 'FAIL' : 'PASS'}  ${target.name.padEnd(18)} ${String(result.checked).padStart(4)} texts, ` +
          `${String(result.surfaces).padStart(3)} surfaces, ${result.height}px` +
          (problems ? `  -> ${result.fails.length} low contrast, ${result.lost.length} lost surfaces` : '') +
          (result.hidden.length ? `  (${result.hidden.length} unpainted)` : ''),
      );
      if (result.sideways) console.log(`      sideways scroll: ${result.sideways}`);
      for (const line of result.noise.slice(0, 5)) console.log(`      ${line}`);
      for (const f of grouped(result.fails, (r) => `${r.path}|${r.fg}|${r.bg}`).slice(0, 40)) {
        console.log(
          `      ${String(f.ratio).padStart(5)} < ${f.need}  ${f.fg} on ${f.bg}  ${f.size}px/${f.weight}  ` +
            `${f.path}  "${f.text}"${f.count > 1 ? `  x${f.count}` : ''}`,
        );
      }
      for (const s of grouped(result.lost, (r) => r.path).slice(0, 40)) {
        console.log(
          `      lost ${s.field ? 'field' : 'surface'}  edge ${s.edge} fill ${s.fill}  ${s.path}` +
            `${s.count > 1 ? `  x${s.count}` : ''}`,
        );
      }
    }
    if (!view.mobile && !flag('no-nav')) {
      const clashes = await auditNav(page);
      report.nav = clashes;
      bad += clashes.length;
      console.log(`${clashes.length ? 'FAIL' : 'PASS'}  nav clear of the facts strip at every width from 320 to 1920`);
      for (const c of clashes.slice(0, 12)) console.log(`      ${c.width}px: ${c.found.join('; ')}`);
      if (clashes.length > 12) console.log(`      … and ${clashes.length - 12} more widths`);
    }
    if (!flag('no-notch') && !flag('sitemap') && (!only || only.split(',').includes('home'))) {
      const rows = await auditNotch(page, view, save);
      report.notch.push(...rows);
      const off = rows.filter((r) => r.differs > 0.01 || r.moved > 2);
      bad += off.length;
      console.log(
        `${off.length ? 'FAIL' : 'PASS'}  notch demo matches the app's dark design in ${rows.length - off.length} of ${rows.length} states`,
      );
      for (const r of off) {
        console.log(
          r.moved > 2
            ? `      ${r.what}: the picture would not hold still (${r.moved}% moved between two shots)`
            : `      ${r.what}: ${r.differs}% of the screen differs`,
        );
      }
    }
    await page.close();
  }
} finally {
  await close();
}

if (save) await writeFile(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));
console.log(`\n${bad ? `${bad} problem(s).` : 'No problems.'}${save ? ` Report: ${path.relative(root, path.join(outDir, 'report.json'))}` : ''}`);
if (bad) process.exitCode = 1;
