/**
 * The stage: tabs, the autoplay loop, the query parameters and the menu bar clock around
 * one interactive notch. All motion goes through the notch's own API (NotchController);
 * nothing here touches the island's DOM.
 */

import {
  FACES,
  getNotch,
  isActivity,
  isFace,
  mountAll,
  type Activity,
  type Face,
  type NotchController,
  type NotchState,
  type SequenceStep,
} from './notch';
import { menuBarClock } from './notch/calendar';

/** Seconds each face stays up while the loop plays, and the closed pause between rounds. */
const HOLD = 2.6;
const HOLD_CLOSED = 1.4;

/** The loop starts and ends on the closed lip with music playing in the right ear. */
const LOOP_START = { state: 'closed', right: 'music', left: null } as const;

export function initStages() {
  mountAll();
  document.querySelectorAll<HTMLElement>('[data-stage]').forEach(initStage);
}

function initStage(stage: HTMLElement) {
  if (stage.dataset.stageReady) return;
  stage.dataset.stageReady = 'true';

  const notch: NotchController | null = getNotch(stage.querySelector('[data-notch]'));
  if (!notch) return;

  const tabs = Array.from(stage.querySelectorAll<HTMLButtonElement>('[role="tab"][data-face]'));
  const panel = stage.querySelector<HTMLElement>('[role="tabpanel"]');
  const copies = Array.from(stage.querySelectorAll<HTMLElement>('[data-face-copy]'));
  const toggle = stage.querySelector<HTMLButtonElement>('[data-autoplay-toggle]');
  const toggleLabel = stage.querySelector<HTMLElement>('[data-autoplay-label]');
  const clock = stage.querySelector<HTMLElement>('[data-live="menubar-clock"]');
  const clockDate = clock?.querySelector<HTMLElement>('[data-live="menubar-date"]');
  const clockTime = clock?.querySelector<HTMLElement>('[data-live="menubar-time"]');
  const barItems = Array.from(stage.querySelectorAll<HTMLElement>('[data-menubar-item]'));
  const tabFor = (face: Face) => tabs.find((tab) => tab.dataset.face === face);

  // ------------------------------------------------------------------ menu bar

  // The lip grows over the menu bar, as it does on a Mac. An item it would cut in half steps
  // aside instead (opacity only); items it leaves alone stay where they are.
  const yieldMenuBar = () => {
    const host = notch.root.parentElement;
    if (!host || !barItems.length) return;
    const box = host.getBoundingClientRect();
    const centre = box.left + host.clientLeft + host.clientWidth / 2;
    const { left, right } = notch.reach;
    const from = centre - left - 4;
    const to = centre + right + 4;
    for (const item of barItems) {
      const at = item.getBoundingClientRect();
      const covered = at.width > 0 && at.right > from && at.left < to;
      if (covered !== item.hasAttribute('data-covered')) item.toggleAttribute('data-covered', covered);
    }
  };

  if (clock && clockDate && clockTime) {
    const tick = () => {
      const now = menuBarClock(new Date());
      if (clockTime.textContent !== now.time) clockTime.textContent = now.time;
      if (clockDate.textContent !== now.date) clockDate.textContent = now.date;
    };
    tick();
    clock.dataset.ready = 'true';
    window.setInterval(tick, 1000);
  }

  // ---------------------------------------------------------------------- tabs

  const selectTab = (face: Face) => {
    for (const tab of tabs) {
      const on = tab.dataset.face === face;
      tab.setAttribute('aria-selected', String(on));
      tab.tabIndex = on ? 0 : -1;
      if (on && panel) panel.setAttribute('aria-labelledby', tab.id);
    }
    for (const copy of copies) copy.hidden = copy.dataset.faceCopy !== face;
  };

  // ------------------------------------------------------------------ autoplay

  let loop: ReturnType<NotchController['sequence']> | null = null;
  let playing = false;

  const setPlaying = (on: boolean) => {
    playing = on;
    stage.dataset.autoplay = on ? 'on' : 'off';
    const label = on ? 'Pause the preview' : 'Play the preview';
    toggle?.setAttribute('aria-label', label);
    if (toggleLabel) toggleLabel.textContent = on ? 'Pause the loop' : 'Play the loop';
    // The caption is only announced when the visitor chose the face, not on every loop step.
    panel?.setAttribute('aria-live', on ? 'off' : 'polite');
  };

  const buildLoop = () => {
    const steps: SequenceStep[] = [
      { ...LOOP_START, hold: HOLD_CLOSED, label: 'closed' },
      ...FACES.map(
        (face): SequenceStep => ({ state: `open:${face}` as NotchState, hold: HOLD, label: `face:${face}` }),
      ),
      { state: 'closed', hold: 0.1 },
    ];
    const tl = notch.sequence(steps, { repeat: -1, from: LOOP_START });
    // The current tab fills up until the next face comes in.
    for (const face of FACES) {
      const bar = tabFor(face)?.querySelector<HTMLElement>('.stab__progress');
      if (!bar) continue;
      tl.fromTo(bar, { scaleX: 0 }, { scaleX: 1, duration: HOLD, ease: 'none' }, `face:${face}`);
      tl.set(bar, { scaleX: 0 }, `face:${face}+=${HOLD + 0.02}`);
    }
    return tl;
  };

  /**
   * Start or stop the loop through the notch, which holds it while the stage is off screen or
   * the tab is hidden. Handing it over again each time keeps the two in step: a stop that
   * happens while the notch is holding the loop stays a stop when the hold ends.
   */
  const run = (on: boolean) => {
    if (!loop) return;
    notch.unmanage(loop);
    if (on) loop.play();
    else loop.pause();
    notch.manage(loop);
  };

  const play = () => {
    if (notch.reduced) return;
    loop ??= buildLoop();
    notch.settle();
    // Pick the loop up where the notch is now, so resuming never jumps.
    if (notch.isOpen) {
      loop.seek(`face:${notch.face}`);
    } else {
      notch.go(LOOP_START, { animate: false });
      loop.seek('closed');
    }
    run(true);
    setPlaying(true);
  };

  const stop = () => {
    if (!playing) return;
    run(false);
    setPlaying(false);
  };

  const show = (face: Face) => {
    stop();
    notch.setState(`open:${face}`, { source: 'user' });
  };

  // -------------------------------------------------------------------- events

  for (const tab of tabs) {
    tab.addEventListener('click', () => {
      const face = tab.dataset.face;
      if (isFace(face)) show(face);
    });
    tab.addEventListener('keydown', (event) => {
      const index = tabs.indexOf(tab);
      let next = -1;
      if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (index + 1) % tabs.length;
      else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = (index - 1 + tabs.length) % tabs.length;
      else if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = tabs.length - 1;
      if (next < 0) return;
      event.preventDefault();
      const target = tabs[next];
      target.focus();
      const face = target.dataset.face;
      if (isFace(face)) show(face);
    });
  }

  toggle?.addEventListener('click', () => (playing ? stop() : play()));

  // Any hover, click or key on the notch itself hands control to the visitor.
  stage.addEventListener('notch:interact', stop);
  stage.addEventListener('notch:statechange', () => {
    selectTab(notch.face);
    yieldMenuBar();
  });
  stage.addEventListener('notch:resize', yieldMenuBar);
  stage.addEventListener('notch:motionchange', () => {
    if (notch.reduced) stop();
    if (toggle) toggle.hidden = notch.reduced;
  });

  // ------------------------------------------------------------- first paint

  const params = new URLSearchParams(window.location.search);
  const face = params.get('face');
  const state = params.get('state');
  const chip = (name: string): Activity | null | undefined => {
    if (!params.has(name)) return undefined;
    const value = params.get(name);
    return isActivity(value) ? value : null;
  };
  const right = chip('right');
  const left = chip('left');
  let autoplay = params.get('autoplay') !== '0';

  if (isFace(face)) {
    notch.go({ state: `open:${face}`, right, left }, { animate: false });
    autoplay = false;
  } else if (state === 'closed' || state === 'peek') {
    notch.go({ state, right, left }, { animate: false });
    autoplay = false;
  } else if (right !== undefined || left !== undefined) {
    notch.go({ state: 'closed', right, left }, { animate: false });
    autoplay = false;
  } else if (notch.reduced) {
    // Reduced motion: a still frame of the first face instead of the loop.
    notch.go({ state: 'open:home' }, { animate: false });
  }

  selectTab(notch.face);
  if (toggle) toggle.hidden = notch.reduced;
  if (autoplay && !notch.reduced) play();
  else setPlaying(false);
  yieldMenuBar();
}
