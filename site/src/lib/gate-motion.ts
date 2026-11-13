import { gsap } from 'gsap';

const reduceMotion = () =>
  typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Entrance for download / trial gate pages. */
export function playGateEnter(root: HTMLElement) {
  const items = root.querySelectorAll('[data-gate-enter]');
  if (!items.length || reduceMotion()) return;
  // Animate only transform — never opacity (avoids stuck half-faded text if the tween is interrupted).
  gsap.from(items, {
    y: 16,
    duration: 0.5,
    stagger: 0.06,
    ease: 'power3.out',
    clearProps: 'transform',
  });
}

/**
 * Download click: pulse the notch island, then follow the link.
 * Returns a promise that resolves when the animation finishes (or immediately if reduced).
 */
export function playDownloadStart(opts: {
  island?: HTMLElement | null;
  button?: HTMLElement | null;
}): Promise<void> {
  const { island, button } = opts;
  if (reduceMotion()) return Promise.resolve();

  return new Promise((resolve) => {
    const tl = gsap.timeline({
      onComplete: () => resolve(),
    });

    if (button) {
      tl.to(button, { scale: 0.96, duration: 0.12, ease: 'power2.out' }, 0).to(
        button,
        { scale: 1, duration: 0.28, ease: 'back.out(2.2)' },
        0.12,
      );
    }

    if (island) {
      island.classList.add('is-firing');
      const ring = island.querySelector('.gate__island-ring');
      tl.fromTo(
        island,
        { scale: 1 },
        { scale: 1.04, duration: 0.22, yoyo: true, repeat: 1, ease: 'power2.inOut' },
        0,
      );
      if (ring) {
        tl.fromTo(
          ring,
          { scale: 0.92, opacity: 0, borderColor: 'rgba(56,140,255,0)' },
          {
            scale: 1.08,
            opacity: 1,
            borderColor: 'rgba(56,140,255,0.65)',
            duration: 0.45,
            ease: 'power2.out',
          },
          0,
        ).to(ring, { opacity: 0, duration: 0.25, ease: 'power1.in' }, 0.4);
      }
      spawnBurst(island, tl, 0.05);
    } else {
      tl.to({}, { duration: 0.35 });
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
  ).to(
    bits,
    { opacity: 0, duration: 0.3, ease: 'power1.in' },
    at + 0.4,
  );
}

/** Wire every [data-gate-download] link to play motion before navigating. */
export function bindDownloadClicks(root: ParentNode = document) {
  root.querySelectorAll<HTMLAnchorElement>('[data-gate-download]').forEach((link) => {
    if (link.dataset.gateBound === '1') return;
    link.dataset.gateBound = '1';
    link.addEventListener('click', (event) => {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      if (link.target === '_blank') return;
      event.preventDefault();
      const island = document.querySelector<HTMLElement>('[data-gate-island]');
      void playDownloadStart({ island, button: link }).then(() => {
        window.location.assign(link.href);
      });
    });
  });
}
