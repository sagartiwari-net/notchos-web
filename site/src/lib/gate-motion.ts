import { gsap } from 'gsap';

const reduceMotion = () =>
  typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Cached DMG blob so a second click saves instantly. */
let cachedBlob: Blob | null = null;
let cachedUrl = '';
let downloadBusy = false;

/** Entrance for download / trial gate pages. */
export function playGateEnter(root: HTMLElement) {
  const items = root.querySelectorAll('[data-gate-enter]');
  if (!items.length || reduceMotion()) return;
  gsap.from(items, {
    y: 16,
    duration: 0.5,
    stagger: 0.06,
    ease: 'power3.out',
    clearProps: 'transform',
  });
}

/**
 * Download click pulse on the app mark (short; progress UI runs in parallel).
 */
export function playDownloadStart(opts: {
  island?: HTMLElement | null;
  button?: HTMLElement | null;
}): Promise<void> {
  const { island, button } = opts;
  if (reduceMotion()) return Promise.resolve();

  return new Promise((resolve) => {
    const tl = gsap.timeline({ onComplete: () => resolve() });

    if (button) {
      tl.to(button, { scale: 0.96, duration: 0.1, ease: 'power2.out' }, 0).to(
        button,
        { scale: 1, duration: 0.22, ease: 'back.out(2)' },
        0.1,
      );
    }

    if (island) {
      island.classList.add('is-firing');
      tl.fromTo(
        island,
        { scale: 1 },
        { scale: 1.03, duration: 0.18, yoyo: true, repeat: 1, ease: 'power2.inOut' },
        0,
      );
    } else {
      tl.to({}, { duration: 0.2 });
    }
  });
}

/** Email success: open the success panel + burst + reveal download CTA. */
export function playTrialSuccess(opts: {
  form?: HTMLElement | null;
  success?: HTMLElement | null;
  downloadBtn?: HTMLElement | null;
}) {
  const { form, success, downloadBtn } = opts;
  if (!(success instanceof HTMLElement)) return;

  success.hidden = false;
  success.classList.add('is-open');

  if (reduceMotion()) {
    gsap.set([success, downloadBtn].filter(Boolean), { clearProps: 'all', opacity: 1, y: 0 });
    return;
  }

  const tl = gsap.timeline();
  if (form) {
    tl.to(form, { opacity: 0.45, duration: 0.25, ease: 'power2.out' }, 0);
  }
  gsap.set(success, { opacity: 0, y: 16, scale: 0.98 });
  tl.to(success, { opacity: 1, y: 0, scale: 1, duration: 0.45, ease: 'power3.out' }, 0.05);
  spawnBurst(success, tl, 0.08);

  if (downloadBtn) {
    gsap.set(downloadBtn, { opacity: 0, y: 10 });
    tl.to(downloadBtn, { opacity: 1, y: 0, duration: 0.4, ease: 'power3.out' }, 0.2);
  }
}

function spawnBurst(host: HTMLElement, tl: gsap.core.Timeline, at: number) {
  let layer = host.querySelector('.gate__burst') as HTMLElement | null;
  if (!layer) {
    layer = document.createElement('div');
    layer.className = 'gate__burst';
    layer.setAttribute('aria-hidden', 'true');
    host.appendChild(layer);
  }
  layer.replaceChildren();

  const colors = ['#388cff', '#40d9c7', '#111113', '#66ebb3', '#1b57c9'];
  const bits: HTMLSpanElement[] = [];
  for (let i = 0; i < 14; i++) {
    const bit = document.createElement('span');
    bit.style.background = colors[i % colors.length]!;
    bit.style.left = '50%';
    bit.style.top = '45%';
    layer.appendChild(bit);
    bits.push(bit);
  }

  tl.fromTo(
    bits,
    { opacity: 0, scale: 0.4, x: 0, y: 0 },
    {
      opacity: 1,
      scale: 1,
      x: () => gsap.utils.random(-90, 90),
      y: () => gsap.utils.random(-70, 50),
      duration: 0.55,
      stagger: 0.015,
      ease: 'power2.out',
    },
    at,
  ).to(bits, { opacity: 0, duration: 0.3, ease: 'power1.in' }, at + 0.4);
}

type ProgressUi = {
  mark: HTMLElement | null;
  ring: SVGGeometryElement | null;
  meta: HTMLElement | null;
  pctEl: HTMLElement | null;
  detailEl: HTMLElement | null;
  fill: HTMLElement | null;
  button: HTMLButtonElement | HTMLAnchorElement | null;
  idleLabel: string;
};

type TransferProgress = {
  received: number;
  total: number;
  bytesPerSec: number | null;
};

function progressUi(button: HTMLElement): ProgressUi {
  const mark = document.querySelector<HTMLElement>('[data-gate-island]');
  return {
    mark,
    ring: mark?.querySelector<SVGGeometryElement>('[data-gate-progress-bar]') ?? null,
    meta: mark?.querySelector<HTMLElement>('[data-gate-progress-meta]') ?? null,
    pctEl: mark?.querySelector<HTMLElement>('[data-gate-progress-pct]') ?? null,
    detailEl: mark?.querySelector<HTMLElement>('[data-gate-progress-detail]') ?? null,
    fill: mark?.querySelector<HTMLElement>('[data-gate-progress-fill]') ?? null,
    button: button as HTMLButtonElement | HTMLAnchorElement,
    idleLabel: button.textContent?.trim() || 'Download',
  };
}

function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0 B';
  if (n < 1024) return `${Math.round(n)} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(n < 10 * 1024 * 1024 ? 2 : 1)} MB`;
}

function formatSpeed(bps: number | null): string {
  if (bps == null || !Number.isFinite(bps) || bps <= 0) return '';
  if (bps < 1024 * 1024) return `${(bps / 1024).toFixed(0)} KB/s`;
  return `${(bps / (1024 * 1024)).toFixed(1)} MB/s`;
}

function setProgress(ui: ProgressUi, transfer: TransferProgress | 'indeterminate' | 'done', status?: string) {
  ui.mark?.classList.add('is-downloading');
  if (ui.meta) ui.meta.hidden = false;

  if (transfer === 'indeterminate') {
    ui.mark?.classList.add('is-indeterminate');
    if (ui.pctEl) ui.pctEl.textContent = '…';
    if (ui.detailEl) ui.detailEl.textContent = status || 'Starting download…';
    if (ui.fill) ui.fill.style.width = '35%';
    if (ui.ring) ui.ring.style.strokeDashoffset = '72';
    return;
  }

  ui.mark?.classList.remove('is-indeterminate');
  const received = transfer === 'done' ? 1 : transfer.received;
  const total = transfer === 'done' ? 1 : transfer.total;
  const ratio = transfer === 'done' ? 1 : total > 0 ? Math.min(1, received / total) : null;
  const pct = ratio == null ? null : Math.round(ratio * 100);

  if (ui.pctEl) {
    ui.pctEl.textContent = pct == null ? formatBytes(received) : `${pct}%`;
  }
  if (ui.detailEl) {
    if (transfer === 'done') {
      ui.detailEl.textContent = status || 'Saving…';
    } else {
      const sizePart = total > 0 ? `${formatBytes(received)} / ${formatBytes(total)}` : formatBytes(received);
      const speedPart = formatSpeed(transfer.bytesPerSec);
      ui.detailEl.textContent = [sizePart, speedPart, status].filter(Boolean).join(' · ');
    }
  }
  if (ui.fill) {
    ui.fill.style.width = pct == null ? '35%' : `${pct}%`;
  }
  if (ui.ring) {
    const ringPct = pct == null ? 12 : Math.max(0, Math.min(100, pct));
    ui.ring.style.strokeDashoffset = String(100 - ringPct);
  }
}

function clearProgress(ui: ProgressUi, finalText?: string) {
  ui.mark?.classList.remove('is-downloading', 'is-indeterminate', 'is-firing');
  if (ui.ring) ui.ring.style.strokeDashoffset = '100';
  if (ui.fill) ui.fill.style.width = '0%';
  if (ui.meta) {
    if (finalText) {
      ui.meta.hidden = false;
      if (ui.pctEl) ui.pctEl.textContent = '✓';
      if (ui.detailEl) ui.detailEl.textContent = finalText;
      if (ui.fill) ui.fill.style.width = '100%';
    } else {
      ui.meta.hidden = true;
      if (ui.pctEl) ui.pctEl.textContent = '0%';
      if (ui.detailEl) ui.detailEl.textContent = '';
    }
  }
  if (ui.button) {
    if (ui.button instanceof HTMLButtonElement) ui.button.disabled = false;
    else ui.button.removeAttribute('aria-busy');
    ui.button.classList.remove('is-busy');
    if ('textContent' in ui.button) ui.button.textContent = ui.idleLabel;
  }
}

async function fetchDmgBlob(
  url: string,
  onProgress: (transfer: TransferProgress | 'indeterminate') => void,
): Promise<Blob> {
  if (cachedBlob && cachedUrl === url) {
    onProgress({ received: 1, total: 1, bytesPerSec: null });
    return cachedBlob;
  }

  // Never force-cache the stable DMG URL — version bumps overwrite the same path.
  const res = await fetch(url, { credentials: 'same-origin', cache: 'no-store' });
  if (!res.ok) throw new Error(`Download failed (${res.status})`);

  const total = Number(res.headers.get('Content-Length') || '0');
  if (!res.body) {
    const blob = await res.blob();
    onProgress({ received: blob.size, total: blob.size || total, bytesPerSec: null });
    cachedBlob = blob;
    cachedUrl = url;
    return blob;
  }

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  const started = performance.now();
  let lastTick = started;
  let lastBytes = 0;
  let bytesPerSec: number | null = null;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      received += value.byteLength;
      const now = performance.now();
      const dt = now - lastTick;
      if (dt >= 200) {
        bytesPerSec = ((received - lastBytes) * 1000) / dt;
        lastTick = now;
        lastBytes = received;
      } else if (bytesPerSec == null && now > started + 80) {
        bytesPerSec = (received * 1000) / Math.max(1, now - started);
      }
      onProgress(
        total > 0
          ? { received, total, bytesPerSec }
          : { received, total: 0, bytesPerSec },
      );
    }
  }

  // Concatenate without spreading huge arrays into Blob constructor awkwardly.
  const merged = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const blob = new Blob([merged], { type: 'application/x-apple-diskimage' });
  cachedBlob = blob;
  cachedUrl = url;
  onProgress({ received, total: total > 0 ? total : received, bytesPerSec });
  return blob;
}

function saveBlob(blob: Blob, filename: string) {
  const objectUrl = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = objectUrl;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 4_000);
}

/**
 * In-page animated download: fetch DMG with progress around the logo, then save the blob.
 * Falls back to a normal navigation if fetch fails.
 */
export async function startInPageDownload(opts: {
  url: string;
  filename: string;
  button: HTMLElement;
}): Promise<void> {
  const { url, filename, button } = opts;
  if (downloadBusy) return;
  downloadBusy = true;

  const ui = progressUi(button);
  if (button instanceof HTMLButtonElement) button.disabled = true;
  else button.setAttribute('aria-busy', 'true');
  button.classList.add('is-busy');
  button.textContent = 'Preparing…';

  void playDownloadStart({ island: ui.mark, button });

  try {
    const fromCache = Boolean(cachedBlob && cachedUrl === url);
    if (fromCache) {
      setProgress(ui, 'done', 'Ready — saving…');
      button.textContent = 'Saving…';
    } else {
      setProgress(ui, 'indeterminate', 'Connecting…');
      button.textContent = 'Downloading…';
    }

    const blob = await fetchDmgBlob(url, (transfer) => {
      if (transfer === 'indeterminate') {
        setProgress(ui, 'indeterminate', 'Downloading…');
        button.textContent = 'Downloading…';
        return;
      }
      setProgress(ui, transfer);
      if (transfer.total > 0) {
        button.textContent = `${Math.round((transfer.received / transfer.total) * 100)}%`;
      } else {
        button.textContent = formatBytes(transfer.received);
      }
    });

    setProgress(ui, 'done', 'Saving to Downloads…');
    button.textContent = 'Saving…';
    saveBlob(blob, filename);

    if (ui.mark && !reduceMotion()) {
      const tl = gsap.timeline();
      spawnBurst(ui.mark, tl, 0);
    }

    clearProgress(ui, 'Saved to your downloads');
    button.textContent = 'Download again';
    window.setTimeout(() => {
      if (ui.detailEl && ui.detailEl.textContent === 'Saved to your downloads') {
        if (ui.meta) ui.meta.hidden = true;
      }
      if (ui.button && ui.button.textContent === 'Download again') {
        ui.button.textContent = ui.idleLabel;
      }
    }, 3200);
  } catch {
    clearProgress(ui);
    button.textContent = ui.idleLabel;
    // Last resort: let the browser handle it the classic way.
    window.location.assign(url);
  } finally {
    downloadBusy = false;
    if (button instanceof HTMLButtonElement) button.disabled = false;
    else button.removeAttribute('aria-busy');
    button.classList.remove('is-busy');
  }
}

/** Wire every [data-gate-download] link to the in-page animated download. */
export function bindDownloadClicks(root: ParentNode = document) {
  root.querySelectorAll<HTMLAnchorElement>('[data-gate-download]').forEach((link) => {
    if (link.dataset.gateBound === '1') return;
    link.dataset.gateBound = '1';
    // Capture so we beat the browser's native <a download> handling.
    link.addEventListener(
      'click',
      (event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        if (link.target === '_blank') return;
        event.preventDefault();
        event.stopPropagation();
        const filename = link.getAttribute('download') || 'NotchOS.dmg';
        void startInPageDownload({ url: link.href, filename, button: link });
      },
      true,
    );
  });
}
