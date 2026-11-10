// Frame rate check for the stage, at 1440 and 390 px wide.
//
// Two measurements per scenario, taken in the same run:
//   1. requestAnimationFrame sampling inside the page: the time from one frame to the next.
//   2. A DevTools trace (the data behind the Performance panel): frames the page's compositor
//      drew, frames the display compositor presented, frames Chrome itself flags as dropped,
//      and how much main-thread time went to script, style, layout and paint.
//
// Scenarios:
//   loop    the autoplay loop as a visitor sees it (closed lip, then face after face)
//   morphs  every face opened in turn through the notch API, then peek and close;
//           only the frames while the island is morphing are counted
//   live    the six closed notches with their live activities in view
//
//   npm run dev            (or: npm run build && npm run preview)
//   npm run fps            -> table on stdout, screenshots/fps.json
//
// Read the numbers with the limits printed at the end in mind: this is headless Chrome.

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SITE_URL, assertSiteUp, launch, sleep } from './browser.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'screenshots');

const VIEWS = [
  { name: '1440', width: 1440, height: 900, dpr: 2, mobile: false, throttle: 1 },
  { name: '1440, CPU slowed 4x', width: 1440, height: 900, dpr: 2, mobile: false, throttle: 4 },
  { name: '390', width: 390, height: 844, dpr: 3, mobile: true, throttle: 1 },
  { name: '390, CPU slowed 4x', width: 390, height: 844, dpr: 3, mobile: true, throttle: 4 },
];

const LOOP_SECONDS = Number(process.env.FPS_LOOP_SECONDS ?? 13);
const LIVE_SECONDS = 5;

const TRACE_CATEGORIES = [
  'devtools.timeline',
  'disabled-by-default-devtools.timeline',
  'disabled-by-default-devtools.timeline.frame',
  'viz',
];
/** Main-thread work, grouped the way the Performance panel's summary groups it. */
const GROUPS = {
  script: ['FunctionCall', 'EvaluateScript', 'v8.compile', 'MinorGC', 'MajorGC'],
  style: ['UpdateLayoutTree', 'RecalculateStyles', 'ParseAuthorStyleSheet'],
  layout: ['Layout'],
  paint: ['PrePaint', 'Paint', 'PaintImage', 'Layerize', 'UpdateLayerTree', 'UpdateLayer', 'CompositeLayers', 'Commit'],
};

await assertSiteUp();
await mkdir(outDir, { recursive: true });

/**
 * One browser per view, with a real window at least as large as the viewport and the real
 * device scale factor. With the default (small) headless window, the display compositor only
 * presents damage that falls inside that small window, and Chrome then flags every other
 * frame as dropped although the page drew it.
 */
function launchFor(view) {
  return launch({
    args: [
      `--window-size=${Math.max(view.width, 500) + 40},${view.height + 140}`,
      `--force-device-scale-factor=${view.dpr}`,
    ],
  });
}

/** Runs in the page. Collects frame-to-frame times between start() and stop(). */
const IN_PAGE = `
window.__frames = {
  start() {
    this.times = [];
    this.on = true;
    const tick = (t) => {
      if (!this.on) return;
      this.times.push(t);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  },
  stop() { this.on = false; return { times: this.times }; },
};
`;

function stats(deltas) {
  if (!deltas.length) return null;
  const sorted = [...deltas].sort((a, b) => a - b);
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  const total = deltas.reduce((sum, d) => sum + d, 0);
  const median = at(0.5);
  return {
    frames: deltas.length,
    seconds: +(total / 1000).toFixed(2),
    fps: +((deltas.length * 1000) / total).toFixed(1),
    medianMs: +median.toFixed(2),
    p95Ms: +at(0.95).toFixed(2),
    p99Ms: +at(0.99).toFixed(2),
    worstMs: +sorted[sorted.length - 1].toFixed(2),
    // A frame that took more than one and a half refresh intervals: at least one was skipped.
    longFrames: deltas.filter((d) => d > median * 1.5).length,
  };
}

const deltasOf = (times) => times.slice(1).map((t, i) => t - times[i]);

/** Frame times that fall inside [from, to] windows (performance.now() values). */
function deltasWithin(times, windows) {
  const out = [];
  for (let i = 1; i < times.length; i++) {
    const t = times[i];
    if (windows.some(([from, to]) => times[i - 1] >= from && t <= to)) out.push(t - times[i - 1]);
  }
  return out;
}

function summariseTrace(buffer, seconds) {
  const { traceEvents } = JSON.parse(Buffer.from(buffer).toString('utf8'));
  // The page's renderer: the process whose main thread ran our animation frames.
  const perPid = new Map();
  for (const e of traceEvents) {
    if (e.name === 'FireAnimationFrame') perPid.set(e.pid, (perPid.get(e.pid) ?? 0) + 1);
  }
  const pid = [...perPid.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  const groupOf = new Map(Object.entries(GROUPS).flatMap(([group, names]) => names.map((n) => [n, group])));
  const ms = { script: 0, style: 0, layout: 0, paint: 0 };
  const count = { Layout: 0, UpdateLayoutTree: 0, Paint: 0 };
  const droppedIds = new Set();
  let drawn = 0;
  let displayDraws = 0;
  let displaySkips = 0;
  let longestTask = 0;
  for (const e of traceEvents) {
    // Display compositor (GPU process): one DrawAndSwap per frame it was asked to show.
    if (e.name === 'Display::DrawAndSwap') displayDraws++;
    else if (e.name === 'Draw skipped.') displaySkips++;
    if (e.pid !== pid) continue;
    if (e.name === 'DrawFrame') drawn++;
    else if (e.name === 'DroppedFrame') droppedIds.add(e.args?.frameSeqId);
    if (e.ph !== 'X' || typeof e.dur !== 'number') continue;
    if (e.name === 'RunTask') longestTask = Math.max(longestTask, e.dur);
    const group = groupOf.get(e.name);
    if (group) ms[group] += e.dur / 1000;
    if (e.name in count) count[e.name]++;
  }
  const per = (v) => +(v / seconds).toFixed(1);
  return {
    seconds: +seconds.toFixed(1),
    framesDrawn: drawn,
    framesPresented: displayDraws - displaySkips,
    framesDropped: droppedIds.size,
    longestTaskMs: +(longestTask / 1000).toFixed(1),
    scriptMsPerSecond: per(ms.script),
    styleMsPerSecond: per(ms.style),
    layoutMsPerSecond: per(ms.layout),
    paintMsPerSecond: per(ms.paint),
    layouts: count.Layout,
    styleRecalcs: count.UpdateLayoutTree,
    paints: count.Paint,
  };
}

async function newPage(browser, view) {
  const page = await browser.newPage();
  await page.setViewport({
    width: view.width,
    height: view.height,
    deviceScaleFactor: view.dpr,
    isMobile: view.mobile,
    hasTouch: view.mobile,
  });
  await page.evaluateOnNewDocument(IN_PAGE);
  return page;
}

async function load(page, query, selector = '.mac') {
  await page.goto(new URL(`/${query}`, SITE_URL).href, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => document.querySelector('#stage-notch')?.dataset.ready === 'true');
  await page.evaluate((s) => document.querySelector(s).scrollIntoView({ block: 'center', behavior: 'instant' }), selector);
  await sleep(400);
}

async function traced(page, run) {
  await page.tracing.start({ categories: TRACE_CATEGORIES });
  const started = Date.now();
  const result = await run();
  const elapsed = (Date.now() - started) / 1000;
  const buffer = await page.tracing.stop();
  return { result, trace: summariseTrace(buffer, elapsed) };
}

// ------------------------------------------------------------------ scenarios

async function loopScenario(browser, view) {
  const page = await newPage(browser, view);
  await load(page, '');
  await page.emulateCPUThrottling(view.throttle);
  const { result, trace } = await traced(page, async () => {
    await page.evaluate(() => {
      window.__states = [];
      document.addEventListener('notch:statechange', (event) => {
        if (event.target.id === 'stage-notch') window.__states.push(event.detail.state);
      });
      window.__frames.start();
    });
    await sleep(LOOP_SECONDS * 1000);
    return page.evaluate(() => ({ ...window.__frames.stop(), states: window.__states }));
  });
  await page.emulateCPUThrottling(1);
  await page.close();
  return { raf: stats(deltasOf(result.times)), trace, states: result.states };
}

async function morphScenario(browser, view) {
  const page = await newPage(browser, view);
  await load(page, '?state=closed&right=music&left=shelf');
  await page.emulateCPUThrottling(view.throttle);
  const { result, trace } = await traced(page, () =>
    page.evaluate(async () => {
      const notch = window.NotchOS.get('stage-notch');
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const windows = [];
      const morph = async (state) => {
        const from = performance.now();
        await new Promise((resolve) => {
          notch.root.addEventListener('notch:settled', resolve, { once: true });
          notch.setState(state);
        });
        windows.push([state, from, performance.now()]);
        await wait(140);
      };
      window.__frames.start();
      await wait(200);
      await morph('peek');
      for (const face of window.NotchOS.faces) await morph(`open:${face}`);
      await morph('closed');
      // And the long way: straight to the tallest face and back.
      await morph('open:ai');
      await morph('closed');
      await wait(100);
      return { ...window.__frames.stop(), windows };
    }),
  );
  await page.emulateCPUThrottling(1);
  await page.close();
  const all = deltasWithin(result.times, result.windows.map(([, from, to]) => [from, to]));
  const perMorph = result.windows.map(([state, from, to]) => {
    const s = stats(deltasWithin(result.times, [[from, to]]));
    return { to: state, ms: +(to - from).toFixed(0), frames: s?.frames ?? 0, fps: s?.fps ?? 0, worstMs: s?.worstMs ?? 0 };
  });
  return { raf: stats(all), trace, perMorph };
}

async function liveScenario(browser, view) {
  const page = await newPage(browser, view);
  await load(page, '?state=closed', '#live .live__grid');
  await page.emulateCPUThrottling(view.throttle);
  const { result, trace } = await traced(page, async () => {
    await page.evaluate(() => window.__frames.start());
    await sleep(LIVE_SECONDS * 1000);
    return page.evaluate(() => ({
      ...window.__frames.stop(),
      running: window.NotchOS.all().filter((n) => n.root.dataset.suspended !== 'true').length,
    }));
  });
  await page.emulateCPUThrottling(1);
  await page.close();
  return { raf: stats(deltasOf(result.times)), trace, notchesRunning: result.running };
}

// ------------------------------------------------------------------------ run

async function environment(browser) {
  const page = await browser.newPage();
  await page.goto(SITE_URL, { waitUntil: 'networkidle0' });
  const info = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl');
    const ext = gl?.getExtension('WEBGL_debug_renderer_info');
    return {
      gpu: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : 'unknown',
      cores: navigator.hardwareConcurrency,
    };
  });
  await page.close();
  return { chrome: await browser.version(), ...info };
}

const report = { url: SITE_URL, at: new Date().toISOString(), env: null, views: [] };
const pad = (v, n) => String(v).padStart(n);
const row = (label, s) =>
  s
    ? `  ${label.padEnd(24)} ${pad(s.fps, 5)} fps   frame time: median ${pad(s.medianMs, 5)} ms, p95 ${pad(s.p95Ms, 5)}, p99 ${pad(s.p99Ms, 5)}, worst ${pad(s.worstMs, 5)} ms   long frames ${s.longFrames} of ${s.frames}`
    : `  ${label.padEnd(24)} no frames`;
const traceRow = (t) =>
  `  ${''.padEnd(24)} trace ${t.seconds} s: drawn ${t.framesDrawn}, presented ${t.framesPresented}, flagged dropped ${t.framesDropped}; main thread per second: script ${t.scriptMsPerSecond} ms, style ${t.styleMsPerSecond} ms, layout ${t.layoutMsPerSecond} ms, paint ${t.paintMsPerSecond} ms; layouts ${t.layouts}; longest task ${t.longestTaskMs} ms`;

for (const view of VIEWS) {
  const { browser, close } = await launchFor(view);
  try {
    if (!report.env) {
      report.env = await environment(browser);
      console.log(`Chrome ${report.env.chrome}, headless, ${report.env.cores} cores`);
      console.log(`GPU: ${report.env.gpu}`);
      console.log(`Site: ${SITE_URL}\n`);
    }
    console.log(`=== ${view.name}  (${view.width}x${view.height} at ${view.dpr}x) ===`);
    const loop = await loopScenario(browser, view);
    console.log(row(`loop, ${LOOP_SECONDS} s`, loop.raf));
    console.log(traceRow(loop.trace));
    console.log(`  ${''.padEnd(24)} states: ${loop.states.join(' > ')}`);
    const morphs = await morphScenario(browser, view);
    console.log(row(`morphs only (${morphs.perMorph.length})`, morphs.raf));
    console.log(traceRow(morphs.trace));
    const slowest = [...morphs.perMorph].sort((a, b) => b.worstMs - a.worstMs)[0];
    console.log(`  ${''.padEnd(24)} slowest frame of any morph: ${slowest.worstMs} ms (to ${slowest.to})`);
    const live = await liveScenario(browser, view);
    console.log(row(`live activities, ${LIVE_SECONDS} s`, live.raf));
    console.log(traceRow(live.trace));
    console.log(`  ${''.padEnd(24)} notches animating: ${live.notchesRunning}\n`);
    report.views.push({ view, loop, morphs, live });
  } finally {
    await close();
  }
}

await writeFile(path.join(outDir, 'fps.json'), JSON.stringify(report, null, 2));
console.log(`Every morph, one by one: ${path.relative(root, path.join(outDir, 'fps.json'))}`);
console.log(`
How to read this:
- "fps" and "frame time" come from requestAnimationFrame in the page. "long frames" are frames
  that took more than 1.5 refresh intervals.
- "drawn" = frames the page's compositor produced, "presented" = frames the display compositor
  showed (it shows nothing when nothing changed), "flagged dropped" = frames Chrome's own
  frame reporter marks as dropped (the red marks in the Performance panel).
Limits:
- Headless Chrome ticks at a fixed 60 Hz, so 60 fps is the ceiling of this run, not of the
  page. A 120 Hz display is not exercised.
- There is no real display behind it, so the final scan-out is not part of the measurement.
- "CPU slowed 4x" is DevTools CPU throttling: it slows the main thread, not the GPU.
- The 390 runs use this Mac's GPU at 3x pixel density; a phone's GPU is not emulated.`);
