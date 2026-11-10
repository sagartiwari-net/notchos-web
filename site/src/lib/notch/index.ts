/**
 * Entry point for the notch component in the browser.
 *
 * Every `<div data-notch>` on the page gets one NotchController. Other scripts on the page
 * import from here; scripts that are not bundled with the site (the promo clip studio in S3,
 * the lead's checks in a browser console) use the same thing through `window.NotchOS`:
 *
 *   const notch = NotchOS.get('stage-notch');     // by id or element
 *   notch.state;                                  // 'closed' | 'peek' | 'open:<face>'
 *   notch.setState('open:calendar');              // morph (GSAP tween returned)
 *   notch.setState('closed', { animate: false }); // apply at once
 *   notch.setActivity({ right: 'timer', left: 'shelf' });
 *   const tl = notch.sequence([{ state: 'open:home', hold: 2 }, { state: 'closed', hold: 1 }]);
 *   tl.play(); tl.pause(); tl.seek(1.2); tl.progress(0.5);
 *   NotchOS.all();                                // every instance on the page
 *   NotchOS.gsap;                                 // the GSAP instance that drives them
 *
 * Frame stepping (for recording): every animation is on GSAP's root timeline, so
 *   NotchOS.gsap.ticker.remove(NotchOS.gsap.updateRoot); NotchOS.gsap.updateRoot(seconds);
 * renders any moment exactly.
 */

import { gsap } from 'gsap';
import { NotchController } from './controller';
import { startLive } from './live';
import { ACTIVITIES, FACES, MODE_SPECS, MOTION } from './tokens';

export { NotchController } from './controller';
export type { GoOptions, Logical, NotchState, SequenceStep } from './controller';
export * from './tokens';

const registry = new Map<HTMLElement, NotchController>();

export function mount(element: HTMLElement): NotchController {
  const existing = registry.get(element);
  if (existing) return existing;
  const controller = new NotchController(element);
  registry.set(element, controller);
  startLive(controller);
  return controller;
}

/** Mount every notch under `scope` that is not mounted yet. Safe to call more than once. */
export function mountAll(scope: ParentNode = document): NotchController[] {
  return Array.from(scope.querySelectorAll<HTMLElement>('[data-notch]')).map(mount);
}

export function getNotch(ref: string | Element | null | undefined): NotchController | null {
  if (!ref) return null;
  const element = typeof ref === 'string' ? document.getElementById(ref) : ref;
  if (!(element instanceof HTMLElement)) return null;
  return registry.get(element) ?? (element.matches('[data-notch]') ? mount(element) : null);
}

export function allNotches(): NotchController[] {
  return Array.from(registry.values());
}

export const NotchOS = {
  get: getNotch,
  all: allNotches,
  mount: mountAll,
  gsap,
  faces: FACES,
  activities: ACTIVITIES,
  motion: MOTION,
  sizes: MODE_SPECS,
};

declare global {
  interface Window {
    NotchOS: typeof NotchOS;
  }
}

if (typeof window !== 'undefined') window.NotchOS = NotchOS;
