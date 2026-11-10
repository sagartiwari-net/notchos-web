/**
 * The small moving and ticking parts inside a notch: music bars, the timer and meeting
 * countdowns, the download ring, the seek bar, and today's date / clocks / calendar.
 *
 * Everything that moves is a GSAP animation registered with the notch (notch.manage), so it
 * pauses when the notch is off screen or the tab is hidden, and it can be stepped frame by
 * frame like the rest (gsap.updateRoot). A part that is not on show (a chip that is not the
 * current one, a face that is not open) is left alone until it is: see gateFor.
 * With prefers-reduced-motion nothing here animates: the still frames rendered by the
 * components stay as they are.
 */

import { gsap } from 'gsap';
import type { NotchController } from './controller';
import { MOTION } from './tokens';
import { clockTime, monthModel, sampleAgenda, shortDate } from './calendar';

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** m:ss, like ClockDeck.clock. */
export function stamp(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

interface RingParts {
  a: HTMLElement | null;
  b: HTMLElement | null;
  cap: HTMLElement | null;
}
const ringParts = new WeakMap<Element, RingParts>();

/** Turn a ring rendered by Ring.astro to a progress between 0 and 1. Transforms only. */
export function setRing(ring: Element, progress: number) {
  let parts = ringParts.get(ring);
  if (!parts) {
    parts = {
      a: ring.querySelector<HTMLElement>('[data-ring-part="a"]'),
      b: ring.querySelector<HTMLElement>('[data-ring-part="b"]'),
      cap: ring.querySelector<HTMLElement>('[data-ring-part="cap"]'),
    };
    ringParts.set(ring, parts);
  }
  const p = clamp01(progress);
  if (parts.a) parts.a.style.transform = `rotate(${Math.min(p, 0.5) * 360}deg)`;
  if (parts.b) {
    parts.b.style.transform = `rotate(${Math.max(p - 0.5, 0) * 360}deg)`;
    parts.b.style.visibility = p > 0.5 ? 'visible' : 'hidden';
  }
  if (parts.cap) parts.cap.style.transform = `rotate(${p * 360}deg)`;
}

/** Demo values. They are sample data, the same on every instance. */
const DEMO = {
  /** Pomodoro focus block: 25 minutes, 18:24 left when the page loads. */
  timer: { total: 25 * 60, left: 18 * 60 + 24 },
  /** Meeting countdown starts five minutes out (AgendaDeck lead). */
  meeting: { left: 4 * 60 + 59 },
  /** Track on the Home face: 3:48 long, 1:12 in. */
  track: { duration: 228, position: 72 },
};

/** PulseBars in TuneChrome.swift: 5 + 8 * (sin(t * 6 + phase) + 1) / 2, three phases. */
const BAR_PHASE = [0, 0.9, 1.7];
const BAR_REST = 7 / 13;

function setText(nodes: HTMLElement[], text: string) {
  for (const node of nodes) if (node.textContent !== text) node.textContent = text;
}

function refreshDates(root: HTMLElement) {
  const now = new Date();
  const find = (name: string) => Array.from(root.querySelectorAll<HTMLElement>(`[data-live="${name}"]`));

  setText(find('date-short'), shortDate(now));
  for (const zone of find('zone')) {
    const text = clockTime(now, undefined, zone.dataset.tz);
    if (zone.textContent !== text) zone.textContent = text;
  }

  const grid = root.querySelector<HTMLElement>('[data-live="cal-grid"]');
  if (grid) {
    const month = monthModel(now);
    const stampKey = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}`;
    if (grid.dataset.stamp !== stampKey) {
      grid.dataset.stamp = stampKey;
      grid.dataset.rows = String(month.rows);
      const cells = Array.from(grid.children) as HTMLElement[];
      month.cells.forEach((cell, index) => {
        const el = cells[index];
        if (!el) return;
        const num = el.firstElementChild as HTMLElement | null;
        if (num) num.textContent = cell ? String(cell.day) : '';
        if (cell?.today) el.dataset.today = 'true';
        else delete el.dataset.today;
        if (cell?.marked) el.dataset.marked = 'true';
        else delete el.dataset.marked;
        if (cell) delete el.dataset.empty;
        else el.dataset.empty = 'true';
      });
      const agenda = sampleAgenda(now);
      setText(find('cal-month'), month.label);
      setText(find('cal-week'), month.week);
      setText(find('cal-selected'), agenda.selected);
      setText(find('cal-today-event'), agenda.todayEvent);
      setText(find('cal-today-reminder'), agenda.todayReminder);
      setText(find('cal-upcoming-event'), agenda.upcomingEvent);
      setText(find('cal-upcoming-reminder'), agenda.upcomingReminder);
    }
  }
}

/**
 * Where a moving part lives: on one open face, or in one chip of the closed lip. It is only
 * written to the DOM while that face or chip is the one on show. The clocks behind it keep
 * running, so a timer or a track is where it should be when it comes back into view, and a
 * notch that shows nothing moving costs no style or paint work at all.
 */
function gateFor(notch: NotchController, element: Element): () => boolean {
  const face = element.closest<HTMLElement>('[data-face-body]')?.dataset.faceBody;
  if (face) {
    const state = `open:${face}`;
    return () => notch.state === state;
  }
  const chip = element.closest<HTMLElement>('[data-chip]');
  const kind = chip?.dataset.chip;
  if (chip && kind) {
    const left = chip.closest<HTMLElement>('[data-ear]')?.dataset.ear === 'left';
    return () => !notch.isOpen && (left ? notch.left : notch.right) === kind;
  }
  return () => true;
}

/**
 * Start the live parts of one notch. Returns a function that stops them.
 */
export function startLive(notch: NotchController): () => void {
  const root = notch.root;
  const find = (selector: string) => Array.from(root.querySelectorAll<HTMLElement>(selector));
  const gated = <T extends Element>(elements: T[]) =>
    elements.map((element) => ({ element, shown: gateFor(notch, element) }));

  // Dates and clocks follow the wall clock. Text only; nothing animates.
  refreshDates(root);
  const clock = window.setInterval(() => {
    if (!document.hidden) refreshDates(root);
  }, 15000);

  const mm = gsap.matchMedia();
  mm.add('(prefers-reduced-motion: no-preference)', () => {
    const made: gsap.core.Animation[] = [];

    // Music bars: closed chip and Home card.
    const bars = gated(find('[data-bars]')).map(({ element, shown }) => ({
      items: Array.from(element.children) as HTMLElement[],
      shown,
    }));
    if (bars.length) {
      let angle = 0;
      const driver = {
        get angle() {
          return angle;
        },
        set angle(value: number) {
          angle = value;
          for (const group of bars) {
            if (!group.shown()) continue;
            for (let k = 0; k < 3; k++) {
              const scale = (5 + 8 * ((Math.sin(value + BAR_PHASE[k]) + 1) / 2)) / 13;
              if (group.items[k]) group.items[k].style.transform = `scaleY(${Math.round(scale * 1000) / 1000})`;
            }
          }
        },
      };
      made.push(gsap.to(driver, { angle: Math.PI * 2, duration: (Math.PI * 2) / 6, ease: 'none', repeat: -1 }));
    }

    // Timer: one demo clock for the closed chip and the Timers face.
    const timerText = find('[data-live="timer-text"]');
    const timerRings = find('[data-ring="timer"]');
    if (timerText.length || timerRings.length) {
      let left = DEMO.timer.left;
      let shown = -1;
      const driver = {
        get left() {
          return left;
        },
        set left(value: number) {
          left = value;
          const seconds = Math.ceil(value);
          if (seconds === shown) return;
          shown = seconds;
          setText(timerText, stamp(seconds));
          const progress = 1 - seconds / DEMO.timer.total;
          for (const ring of timerRings) setRing(ring, progress);
        },
      };
      made.push(gsap.to(driver, { left: 0, duration: DEMO.timer.left, ease: 'none', repeat: -1 }));
    }

    // Meeting countdown.
    const meetingText = find('[data-live="meeting-text"]');
    if (meetingText.length) {
      let left = DEMO.meeting.left;
      let shown = -1;
      const driver = {
        get left() {
          return left;
        },
        set left(value: number) {
          left = value;
          const seconds = Math.ceil(value);
          if (seconds === shown) return;
          shown = seconds;
          setText(meetingText, stamp(seconds));
        },
      };
      made.push(gsap.to(driver, { left: 0, duration: DEMO.meeting.left, ease: 'none', repeat: -1 }));
    }

    // Download ring fills, rests, starts again.
    const downloadRings = find('[data-ring="download"]');
    const downloadGates = gated(downloadRings);
    if (downloadRings.length) {
      let progress = 0.06;
      const driver = {
        get progress() {
          return progress;
        },
        set progress(value: number) {
          progress = value;
          for (const ring of downloadGates) if (ring.shown()) setRing(ring.element, value);
        },
      };
      made.push(
        gsap
          .timeline({ repeat: -1, repeatDelay: 1.2 })
          .fromTo(driver, { progress: 0.06 }, { progress: 1, duration: 5.6, ease: 'power1.inOut' }),
      );
    }

    // Seek bar on the Home face.
    const seekFill = gated(find('[data-live="seek-fill"]'));
    if (seekFill.length) {
      const elapsed = find('[data-live="seek-elapsed"]');
      const remaining = find('[data-live="seek-left"]');
      const { duration, position: startAt } = DEMO.track;
      let position = startAt;
      let shown = -1;
      const driver = {
        get position() {
          return position;
        },
        set position(value: number) {
          position = value;
          const css = `scaleX(${Math.round((value / duration) * 1e4) / 1e4})`;
          for (const fill of seekFill) if (fill.shown()) fill.element.style.transform = css;
          const seconds = Math.floor(value);
          if (seconds === shown) return;
          shown = seconds;
          setText(elapsed, stamp(seconds));
          setText(remaining, `-${stamp(duration - seconds)}`);
        },
      };
      made.push(
        gsap.fromTo(
          driver,
          { position: startAt },
          { position: duration, duration: duration - startAt, ease: 'none', repeat: -1 },
        ),
      );
    }

    // Live status breathe (NotchMotion.pulsePeriod, pulseOpacityMin).
    const pulse = gated(find('[data-live="pulse"]'));
    if (pulse.length) {
      let level = 1;
      const driver = {
        get level() {
          return level;
        },
        set level(value: number) {
          level = value;
          const css = String(Math.round(value * 1000) / 1000);
          for (const dot of pulse) if (dot.shown()) dot.element.style.opacity = css;
        },
      };
      made.push(
        gsap.fromTo(
          driver,
          { level: 1 },
          { level: MOTION.pulseMin, duration: MOTION.pulsePeriod / 2, ease: 'sine.inOut', repeat: -1, yoyo: true },
        ),
      );
    }

    for (const animation of made) notch.manage(animation);

    return () => {
      for (const animation of made) {
        notch.unmanage(animation);
        animation.kill();
      }
      // Back to the still frames the components rendered.
      for (const group of bars) for (const bar of group.items) bar.style.transform = `scaleY(${BAR_REST})`;
      setText(timerText, stamp(DEMO.timer.left));
      for (const ring of timerRings) setRing(ring, 1 - DEMO.timer.left / DEMO.timer.total);
      setText(meetingText, stamp(DEMO.meeting.left));
      for (const ring of downloadRings) setRing(ring, 0.62);
      for (const dot of pulse) dot.element.style.opacity = '';
    };
  });

  return () => {
    window.clearInterval(clock);
    mm.revert();
  };
}
