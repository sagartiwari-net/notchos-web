/**
 * NotchController: one NotchOS island on the page.
 *
 * It owns a `<div data-notch>` rendered by src/components/notch/Notch.astro and nothing else.
 * Everything that moves is driven from here with GSAP, so outside code (the stage, the scroll
 * story, the promo clip studio) can set a state, play, pause and seek without knowing the DOM.
 *
 * Motion rule of the site: transforms and opacity only. The island outline is therefore not an
 * animated path. It is assembled from solid pieces (a body, a floor, two bottom corners, two top
 * flares) that are translated and scaled, and the face content sits in a clip window made of
 * three nested overflow boxes that only translate. Nothing here changes layout while it animates.
 *
 * Public surface (see index.ts for `window.NotchOS`):
 *   notch.state / notch.face / notch.left / notch.right     current logical state
 *   notch.setState('closed' | 'peek' | 'open:<face>', opts)  morph to a state
 *   notch.setActivity({ left, right }, opts)                 closed-lip live activity chips
 *   notch.go({ state, left, right }, opts)                   both at once
 *   notch.sequence(steps, vars)                              a GSAP timeline through states:
 *                                                            play(), pause(), seek(), progress()
 *   notch.manage(animation)                                  pause with the notch when it is off
 *                                                            screen or the tab is hidden
 *   notch.reach                                              { left, right, height } of the settled lip
 *   notch.refresh()                                          re-measure (mode and fit)
 *   events on the root (they bubble): notch:statechange, notch:interact, notch:settled,
 *   notch:modechange, notch:resize, notch:motionchange
 */

import { gsap } from 'gsap';
import {
  ACTIVITIES,
  CLIP,
  FACES,
  HAIRLINE,
  MODE_SPECS,
  MOTION,
  PIECE,
  REST_INSET,
  isFace,
  type Activity,
  type Face,
  type Mode,
} from './tokens';

export type NotchState = 'closed' | 'peek' | `open:${Face}`;

export interface Logical {
  state: NotchState;
  /** Live activity in the left ear of the closed lip (secondary). */
  left: Activity | null;
  /** Live activity in the right ear of the closed lip (primary). */
  right: Activity | null;
}

export interface GoOptions {
  /** false applies the state at once. Reduced motion always does. */
  animate?: boolean;
  /** Seconds. Defaults to the app's timing for this kind of change. */
  duration?: number;
  /** Any GSAP ease name. */
  ease?: string;
  /** 'user' marks a change that came from the visitor (hover, click, key). */
  source?: 'api' | 'user';
}

export interface SequenceStep extends Partial<Logical> {
  /** Seconds to stay in this state after the morph. */
  hold?: number;
  duration?: number;
  ease?: string;
  /** Timeline label placed where the morph has finished. Defaults to `step-<index>`. */
  label?: string;
}

interface Geo {
  /** Outer left and right edge of the lip, measured from the camera centre. */
  xl: number;
  xr: number;
  h: number;
  /** Upper (concave flare) and lower (convex) corner radius. */
  u: number;
  l: number;
  /** 0 closed ... 1 open. Drives the chrome fade like SurfaceRoot's `reveal`. */
  open: number;
  earL: number;
  earR: number;
}

interface Frame {
  geo: Geo;
  /** Opacity of each face body, in FACES order. */
  face: number[];
  /** Opacity of each chip in the left / right ear, in ACTIVITIES order. */
  left: number[];
  right: number[];
}

interface LipPieces {
  core: HTMLElement;
  floor: HTMLElement;
  cornerL: HTMLElement;
  cornerR: HTMLElement;
  flareL: HTMLElement;
  flareR: HTMLElement;
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const smoothstep = (e0: number, e1: number, x: number) => {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};
const easeOutQuad = (t: number) => 1 - (1 - t) * (1 - t);
const n = (v: number) => Math.round(v * 100) / 100;
const scaleOf = (sx: number, sy: number) =>
  sx === 1 && sy === 1 ? '' : ` scale(${Math.round(sx * 1e5) / 1e5},${Math.round(sy * 1e5) / 1e5})`;
type Place = (x: number, y: number, sx?: number, sy?: number) => string;
/** The island that morphs across the stage: every piece on its own compositor layer. */
const place3d: Place = (x, y, sx = 1, sy = sx) => `translate3d(${n(x)}px,${n(y)}px,0)${scaleOf(sx, sy)}`;
/** A closed-only lip: plain 2D, so its few small shapes are painted with their card. */
const place2d: Place = (x, y, sx = 1, sy = sx) => `translate(${n(x)}px,${n(y)}px)${scaleOf(sx, sy)}`;

function emptyFrame(): Frame {
  return {
    geo: { xl: 0, xr: 0, h: 0, u: 0, l: 0, open: 0, earL: 0, earR: 0 },
    face: FACES.map(() => 0),
    left: ACTIVITIES.map(() => 0),
    right: ACTIVITIES.map(() => 0),
  };
}

function copyFrame(from: Frame, into: Frame): Frame {
  Object.assign(into.geo, from.geo);
  for (let i = 0; i < from.face.length; i++) into.face[i] = from.face[i];
  for (let i = 0; i < from.left.length; i++) {
    into.left[i] = from.left[i];
    into.right[i] = from.right[i];
  }
  return into;
}

export function parseState(state: NotchState): { stance: 'closed' | 'peek' | 'open'; face?: Face } {
  if (state === 'closed' || state === 'peek') return { stance: state };
  const face = state.slice(5);
  return { stance: 'open', face: isFace(face) ? face : 'home' };
}

/** Out first, in second: the leaving layer is gone before the arriving one shows. */
function stage(from: number[], to: number[], t: number, instant: boolean, out: number[]) {
  for (let i = 0; i < from.length; i++) {
    const a = from[i];
    const b = to[i];
    if (instant || a === b) out[i] = b;
    else if (b < a) out[i] = lerp(a, b, easeOutQuad(clamp01(t / 0.4)));
    else out[i] = lerp(a, b, easeOutQuad(clamp01((t - 0.5) / 0.5)));
  }
}

function mixFrames(a: Frame, b: Frame, t: number, e: number, out: Frame) {
  const g = out.geo;
  g.xl = lerp(a.geo.xl, b.geo.xl, e);
  g.xr = lerp(a.geo.xr, b.geo.xr, e);
  g.h = lerp(a.geo.h, b.geo.h, e);
  g.u = lerp(a.geo.u, b.geo.u, e);
  g.l = lerp(a.geo.l, b.geo.l, e);
  g.open = lerp(a.geo.open, b.geo.open, e);
  g.earL = lerp(a.geo.earL, b.geo.earL, e);
  g.earR = lerp(a.geo.earR, b.geo.earR, e);
  // Faces only show while the lip is open; chips only while it is closed. Whatever is hidden
  // at the start of a morph is swapped at once, so nothing ghosts in half way.
  stage(a.face, b.face, t, a.geo.open < 0.5, out.face);
  const chipsHidden = a.geo.open > 0.5;
  stage(a.left, b.left, t, chipsHidden, out.left);
  stage(a.right, b.right, t, chipsHidden, out.right);
}

const WIDE_MIN_FACES = 700;
const WIDE_MIN_CLOSED = 440;

export class NotchController {
  readonly root: HTMLElement;
  readonly id: string;
  /** False for closed-only instances (no face markup inside). */
  readonly hasFaces: boolean;
  /** True when the visitor can hover, click and press Escape on this instance. */
  readonly interactive: boolean;

  mode: Mode = 'wide';
  fit = 1;

  private logical: Logical = { state: 'closed', left: null, right: null };
  private currentFace: Face = 'home';
  private cur: Frame = emptyFrame();
  private scratchA: Frame = emptyFrame();
  private scratchB: Frame = emptyFrame();
  private scratchReach: Frame = emptyFrame();
  private tween: gsap.core.Tween | null = null;
  private managed = new Map<gsap.core.Animation, boolean>();
  private inView = true;
  private suspended = false;
  private ready = false;
  private reducedQuery: MediaQueryList;
  private cleanup: Array<() => void> = [];

  private stroke: LipPieces | null;
  private fillOpen: LipPieces | null;
  private fillClosed: LipPieces | null;
  private closedTone: HTMLElement | null;
  private shadow: HTMLElement | null;
  private gloss: HTMLElement | null;
  private clipB: HTMLElement | null;
  private clipL: HTMLElement | null;
  private clipR: HTMLElement | null;
  private content: HTMLElement | null;
  private chrome: HTMLElement | null;
  private wings: HTMLElement | null;
  private earLeft: HTMLElement | null;
  private earRight: HTMLElement | null;
  private grip: HTMLElement | null;
  private tools: HTMLElement | null;
  private hit: HTMLButtonElement | null;
  private faceEls: Array<HTMLElement | null>;
  private tabOn: Array<HTMLElement | null>;
  private chipsLeft: Array<HTMLElement | null>;
  private chipsRight: Array<HTMLElement | null>;
  private lastOpacity = new WeakMap<HTMLElement, number>();
  private place: Place = place3d;

  constructor(root: HTMLElement) {
    this.root = root;
    this.id = root.id || `notch-${Math.random().toString(36).slice(2, 8)}`;
    this.interactive = root.dataset.interactive === 'true';

    const q = <T extends HTMLElement = HTMLElement>(selector: string) =>
      root.querySelector<T>(selector);
    const pieces = (group: HTMLElement | null): LipPieces | null => {
      if (!group) return null;
      const get = (name: string) => group.querySelector<HTMLElement>(`[data-piece="${name}"]`);
      const core = get('core');
      const floor = get('floor');
      const cornerL = get('corner-l');
      const cornerR = get('corner-r');
      const flareL = get('flare-l');
      const flareR = get('flare-r');
      if (!core || !floor || !cornerL || !cornerR || !flareL || !flareR) return null;
      return { core, floor, cornerL, cornerR, flareL, flareR };
    };

    this.stroke = pieces(q('[data-lip="stroke"]'));
    this.fillOpen = pieces(q('[data-lip="open"]'));
    this.closedTone = q('[data-lip="closed"]');
    this.fillClosed = pieces(this.closedTone);
    this.shadow = q('[data-part="shadow"]');
    this.gloss = q('[data-part="gloss"]');
    this.clipB = q('[data-clip="b"]');
    this.clipL = q('[data-clip="l"]');
    this.clipR = q('[data-clip="r"]');
    this.content = q('[data-part="content"]');
    this.chrome = q('[data-part="chrome"]');
    this.wings = q('[data-part="wings"]');
    this.earLeft = q('[data-ear="left"]');
    this.earRight = q('[data-ear="right"]');
    this.grip = q('[data-part="grip"]');
    this.tools = q('[data-part="tools"]');
    this.hit = q<HTMLButtonElement>('[data-part="hit"]');
    this.faceEls = FACES.map((face) => q(`[data-face-body="${face}"]`));
    this.tabOn = FACES.map((face) => q(`[data-tab-on="${face}"]`));
    this.chipsLeft = ACTIVITIES.map((a) => this.earLeft?.querySelector<HTMLElement>(`[data-chip="${a}"]`) ?? null);
    this.chipsRight = ACTIVITIES.map((a) => this.earRight?.querySelector<HTMLElement>(`[data-chip="${a}"]`) ?? null);
    this.hasFaces = this.faceEls.some(Boolean);
    this.place = this.hasFaces ? place3d : place2d;

    this.reducedQuery = window.matchMedia('(prefers-reduced-motion: reduce)');

    // Initial logical state from the markup.
    const initial = root.dataset.state as NotchState | undefined;
    const face = root.dataset.face;
    if (isFace(face)) this.currentFace = face;
    this.logical = {
      state: initial && this.validState(initial) ? initial : 'closed',
      left: this.chipOrNull(root.dataset.left, 'left'),
      right: this.chipOrNull(root.dataset.right, 'right'),
    };
    const parsed = parseState(this.logical.state);
    if (parsed.face) this.currentFace = parsed.face;

    this.measure();
    this.frameOf(this.logical, this.cur);
    this.commit(this.logical, true);
    this.render();
    this.bind();
    this.ready = true;
    root.dataset.ready = 'true';
  }

  // ------------------------------------------------------------------ state

  get state(): NotchState {
    return this.logical.state;
  }
  get face(): Face {
    return this.currentFace;
  }
  get left(): Activity | null {
    return this.logical.left;
  }
  get right(): Activity | null {
    return this.logical.right;
  }
  get isOpen(): boolean {
    return this.logical.state.startsWith('open:');
  }
  get reduced(): boolean {
    return this.reducedQuery.matches;
  }
  /** True while a one-off morph started by setState / setActivity / go is running. */
  get busy(): boolean {
    return this.tween !== null;
  }
  /**
   * Where the lip settles in the current state, in the host's own pixels: how far it reaches
   * left and right of the camera centre, and how far down. For things drawn around the notch
   * (menu bar items that step aside, callouts that point at the island).
   */
  get reach(): { left: number; right: number; height: number } {
    const g = this.frameOf(this.logical, this.scratchReach).geo;
    return { left: -g.xl * this.fit, right: g.xr * this.fit, height: g.h * this.fit };
  }

  setState(state: NotchState, options: GoOptions = {}) {
    return this.go({ state }, options);
  }

  setActivity(sides: { left?: Activity | null; right?: Activity | null }, options: GoOptions = {}) {
    return this.go(sides, options);
  }

  /**
   * Morph from whatever is on screen now to the given state. Safe to call mid-morph: the new
   * morph starts from the current, interpolated pose. Returns the GSAP tween, or null when the
   * change was applied at once (reduced motion, animate: false, or nothing to do).
   */
  go(patch: Partial<Logical>, options: GoOptions = {}): gsap.core.Tween | null {
    const from = this.logical;
    const to: Logical = {
      state: patch.state && this.validState(patch.state) ? patch.state : from.state,
      left: patch.left === undefined ? from.left : this.chipOrNull(patch.left, 'left'),
      right: patch.right === undefined ? from.right : this.chipOrNull(patch.right, 'right'),
    };
    const same = to.state === from.state && to.left === from.left && to.right === from.right;
    if (same && !this.tween) return null;

    this.tween?.kill();
    this.tween = null;

    const start = copyFrame(this.cur, this.scratchA);
    this.commit(to, false, options.source);
    const target = this.frameOf(to, this.scratchB);

    const animate = options.animate !== false && !this.reduced && this.ready;
    const duration = animate ? (options.duration ?? this.durationFor(from, to)) : 0;
    if (duration <= 0) {
      copyFrame(target, this.cur);
      this.render();
      this.setBusy(false);
      this.emit('notch:settled');
      return null;
    }

    const ease = gsap.parseEase(options.ease ?? this.easeFor(from, to));
    // The start and target frames must survive until the tween ends, so they get their own copies.
    const a = copyFrame(start, emptyFrame());
    const b = copyFrame(target, emptyFrame());
    const self = this;
    let t = 0;
    const driver = {
      get t() {
        return t;
      },
      set t(value: number) {
        t = value;
        mixFrames(a, b, value, ease(value), self.cur);
        self.render();
      },
    };
    this.setBusy(true);
    this.tween = gsap.to(driver, {
      t: 1,
      duration,
      ease: 'none',
      onComplete: () => {
        this.tween = null;
        this.setBusy(false);
        this.emit('notch:settled');
      },
    });
    return this.tween;
  }

  /** Finish a running one-off morph at once (the notch jumps to its target pose). */
  settle() {
    this.tween?.progress(1);
  }

  /**
   * A paused GSAP timeline that walks through the given states. It can be played, paused,
   * reversed, seeked or scrubbed (ScrollTrigger), because every step is rendered as a pure
   * function of its progress: no callbacks, no timers.
   *
   *   const tl = notch.sequence([{ state: 'open:home', hold: 2 }, { state: 'open:tray', hold: 2 }]);
   *   tl.play();
   *
   * The first step morphs from `vars.from` (default: the state the notch is in right now).
   * For a seamless loop, end on the state you started from and pass `repeat: -1`.
   */
  sequence(
    steps: SequenceStep[],
    vars: gsap.TimelineVars & { from?: Partial<Logical> } = {},
  ): gsap.core.Timeline {
    const { from, ...timelineVars } = vars;
    const tl = gsap.timeline({ paused: true, ...timelineVars });
    let prev: Logical = { ...this.logical, ...from };
    let at = 0;
    steps.forEach((step, index) => {
      const next: Logical = {
        state: step.state && this.validState(step.state) ? step.state : prev.state,
        left: step.left === undefined ? prev.left : this.chipOrNull(step.left, 'left'),
        right: step.right === undefined ? prev.right : this.chipOrNull(step.right, 'right'),
      };
      const a = prev;
      const b = next;
      const duration = step.duration ?? this.durationFor(a, b);
      const ease = gsap.parseEase(step.ease ?? this.easeFor(a, b));
      const self = this;
      let t = 0;
      const driver = {
        get t() {
          return t;
        },
        set t(value: number) {
          t = value;
          self.renderBetween(a, b, value, ease(value));
        },
      };
      tl.to(driver, { t: 1, duration, ease: 'none' }, at);
      at += duration;
      tl.addLabel(step.label ?? `step-${index}`, at);
      at += step.hold ?? 0;
      prev = next;
    });
    // Keep the playhead running through the last hold.
    if (at > tl.duration()) tl.set({}, {}, at);
    return tl;
  }

  /**
   * Register an animation that should only run while this notch is visible: it is paused when
   * the notch scrolls off screen or the tab is hidden, and resumed afterwards if it was playing.
   */
  manage<T extends gsap.core.Animation>(animation: T): T {
    this.managed.set(animation, false);
    if (this.suspended && !animation.paused()) {
      this.managed.set(animation, true);
      animation.pause();
    }
    return animation;
  }

  unmanage(animation: gsap.core.Animation) {
    this.managed.delete(animation);
  }

  /** Re-measure the host, pick wide or compact, fit to the width, and redraw. */
  refresh() {
    const before = this.mode;
    this.measure();
    if (!this.tween) this.frameOf(this.logical, this.cur);
    this.placeHit();
    this.render();
    if (before !== this.mode) this.emit('notch:modechange');
    this.emit('notch:resize');
  }

  destroy() {
    this.tween?.kill();
    this.cleanup.forEach((fn) => fn());
    this.cleanup = [];
    this.managed.clear();
  }

  // ---------------------------------------------------------------- geometry

  private get spec() {
    return MODE_SPECS[this.mode];
  }

  private validState(state: string): state is NotchState {
    if (state === 'closed' || state === 'peek') return true;
    if (!state.startsWith('open:')) return false;
    const face = state.slice(5);
    return isFace(face) && (!this.ready || this.hasFaces);
  }

  private chipOrNull(value: unknown, side: 'left' | 'right'): Activity | null {
    if (typeof value !== 'string') return null;
    const index = (ACTIVITIES as readonly string[]).indexOf(value);
    if (index < 0) return null;
    const list = side === 'left' ? this.chipsLeft : this.chipsRight;
    return list[index] ? (value as Activity) : null;
  }

  private earWidths(left: Activity | null, right: Activity | null) {
    // GlanceHub.earWidth: a chip gets its content width plus padding on both sides. A lone chip
    // still grows the other side a little, so the lip stays balanced around the camera.
    const { extra, earPad, balanceMax } = this.spec;
    const ear = (own: Activity | null, other: Activity | null) => {
      if (own) return extra[own] + earPad * 2;
      if (other) return Math.min(extra[other] + earPad * 2, balanceMax);
      return 0;
    };
    return { earL: ear(left, right), earR: ear(right, left) };
  }

  /** The pose a logical state settles in, for the current mode. */
  private frameOf(logical: Logical, into: Frame): Frame {
    const spec = this.spec;
    const { stance, face } = parseState(logical.state);
    const { earL, earR } = this.earWidths(logical.left, logical.right);
    const half = spec.housing.w / 2;
    const restH = spec.housing.h - REST_INSET;
    const g = into.geo;
    g.earL = earL;
    g.earR = earR;
    if (stance === 'open') {
      const shown = face ?? this.currentFace;
      g.xl = -spec.open.w / 2;
      g.xr = spec.open.w / 2;
      g.h = spec.faces[shown];
      g.u = spec.open.u;
      g.l = spec.open.l;
      g.open = 1;
    } else if (stance === 'peek') {
      g.xl = -(half + earL) - spec.peek.dw / 2;
      g.xr = half + earR + spec.peek.dw / 2;
      g.h = restH + spec.peek.dh;
      g.u = spec.peek.u;
      g.l = spec.peek.l;
      g.open = 0;
    } else {
      g.xl = -(half + earL);
      g.xr = half + earR;
      g.h = restH;
      g.u = spec.rest.u;
      g.l = spec.rest.l;
      g.open = 0;
    }
    const shownFace = face ?? this.faceAfter(logical);
    for (let i = 0; i < FACES.length; i++) into.face[i] = FACES[i] === shownFace ? 1 : 0;
    for (let i = 0; i < ACTIVITIES.length; i++) {
      into.left[i] = ACTIVITIES[i] === logical.left ? 1 : 0;
      into.right[i] = ACTIVITIES[i] === logical.right ? 1 : 0;
    }
    return into;
  }

  /** Closed and peek keep showing the last face, like the app (ScreenShell.face persists). */
  private faceAfter(logical: Logical): Face {
    return parseState(logical.state).face ?? this.currentFace;
  }

  private durationFor(from: Logical, to: Logical): number {
    const a = parseState(from.state);
    const b = parseState(to.state);
    if (a.stance === 'open' && b.stance === 'open') {
      const heights = this.spec.faces;
      return heights[a.face ?? 'home'] === heights[b.face ?? 'home'] ? MOTION.swap : MOTION.island;
    }
    if (a.stance === 'open' || b.stance === 'open') return MOTION.island;
    if (from.state !== to.state) return MOTION.peek;
    return MOTION.wing;
  }

  private easeFor(from: Logical, to: Logical): string {
    const a = parseState(from.state).stance;
    const b = parseState(to.state).stance;
    if (a === 'open' || b === 'open') return MOTION.islandEase;
    if (from.state !== to.state) return MOTION.peekEase;
    return MOTION.islandEase;
  }

  private measure() {
    const host = (this.root.offsetParent as HTMLElement | null) ?? this.root.parentElement;
    const avail = host?.clientWidth ?? 0;
    if (!avail) return;
    const lock = this.root.dataset.modeLock;
    let mode: Mode;
    if (lock === 'wide' || lock === 'compact') mode = lock;
    else if (this.hasFaces) mode = avail >= WIDE_MIN_FACES ? 'wide' : 'compact';
    else mode = avail >= WIDE_MIN_CLOSED ? 'wide' : 'compact';
    this.mode = mode;

    const spec = MODE_SPECS[mode];
    let need: number;
    let ceiling = 1;
    if (this.hasFaces) {
      need = spec.open.w + (mode === 'wide' ? 28 : 20);
      // A phone screen is narrower than the compact island's design width at some sizes and a
      // little wider at others; let it grow a touch so it fills the screen.
      ceiling = mode === 'wide' ? 1 : 1.12;
    } else {
      // Closed-only instance: room for its widest chip on each side, plus the peek swell.
      const widest = (chips: Array<HTMLElement | null>) =>
        Math.max(0, ...ACTIVITIES.map((a, i) => (chips[i] ? spec.extra[a] : 0)));
      const pad = spec.earPad * 2;
      const l = widest(this.chipsLeft);
      const r = widest(this.chipsRight);
      const earL = l ? l + pad : r ? Math.min(r + pad, spec.balanceMax) : 0;
      const earR = r ? r + pad : l ? Math.min(l + pad, spec.balanceMax) : 0;
      // The lip is centred on the camera, so the wider side decides.
      need = spec.housing.w + Math.max(earL, earR) * 2 + spec.peek.dw + 16;
    }
    this.fit = Math.max(0.3, Math.min(ceiling, avail / need));
    this.root.dataset.mode = mode;
    // On the host, so things drawn around the notch (a menu bar) can follow the same scale.
    if (host) {
      host.style.setProperty('--notch-fit', String(Math.round(this.fit * 1e4) / 1e4));
      host.dataset.notchMode = mode;
    }
  }

  // ------------------------------------------------------------------ render

  private renderBetween(a: Logical, b: Logical, t: number, e: number) {
    // A one-off morph (hover, click) wins over a timeline that is still being scrubbed.
    if (this.tween) return;
    const fa = this.frameOf(a, this.scratchA);
    // Entering a face: the leaving face is `a`'s, so resolve `a` before committing `b`.
    this.commit(t > 0 ? b : a, false);
    const fb = this.frameOf(b, this.scratchB);
    if (t <= 0) copyFrame(this.frameOf(a, this.scratchA), this.cur);
    else if (t >= 1) copyFrame(fb, this.cur);
    else mixFrames(fa, fb, t, e, this.cur);
    this.render();
  }

  private setLip(p: LipPieces | null, xl: number, xr: number, h: number, u: number, l: number) {
    if (!p) return;
    const place = this.place;
    const bodyL = xl + u;
    const bodyR = xr - u;
    const bodyW = Math.max(bodyR - bodyL, 1);
    // lipPath clamps the lower radius the same way.
    const low = Math.max(Math.min(l, bodyW / 2, h), 0.5);
    p.core.style.transform = place(bodyL, 0, bodyW / PIECE.coreW, Math.max(h - low + 1, 1) / PIECE.coreH);
    p.floor.style.transform = place(
      bodyL + low - 1,
      h - low - 1,
      Math.max(bodyW - 2 * low + 2, 1) / PIECE.floorW,
      (low + 1) / PIECE.floorH,
    );
    const cs = low / PIECE.corner;
    p.cornerL.style.transform = place(bodyL, h - low, cs);
    p.cornerR.style.transform = place(bodyR - low, h - low, cs);
    const fs = Math.max(u, 0.1) / PIECE.flare;
    p.flareL.style.transform = place(xl, 0, fs);
    p.flareR.style.transform = place(xr - (PIECE.flare + PIECE.flareOverlap) * fs, 0, fs);
  }

  private fade(el: HTMLElement | null, value: number) {
    if (!el) return;
    const v = value < 0.004 ? 0 : value > 0.996 ? 1 : Math.round(value * 1000) / 1000;
    if (this.lastOpacity.get(el) === v) return;
    this.lastOpacity.set(el, v);
    el.style.opacity = String(v);
    // 'inherit', not 'visible': a face inside the hidden chrome must stay hidden with it.
    el.style.visibility = v === 0 ? 'hidden' : 'inherit';
  }

  private render() {
    const { geo, face, left, right } = this.cur;
    const { xl, xr, h, u, l, open } = geo;
    const spec = this.spec;
    const place = this.place;

    // Outline: the hairline is the same silhouette, 0.8 px larger, in white under the fill.
    this.setLip(this.stroke, xl, xr, h + HAIRLINE, Math.max(u - HAIRLINE, 0.1), l + HAIRLINE);
    this.setLip(this.fillOpen, xl, xr, h, u, l);
    this.setLip(this.fillClosed, xl, xr, h, u, l);
    // Closed is black like the camera housing; open is the denser card glass.
    this.fade(this.closedTone, 1 - smoothstep(0.04, 0.5, open));

    const bodyL = xl + u;
    const bodyR = xr - u;

    if (this.gloss) {
      this.gloss.style.transform = place(bodyL, 0, (bodyR - bodyL) / PIECE.glossW, 1);
      this.fade(this.gloss, smoothstep(0.2, 0.8, open));
    }
    if (this.shadow) {
      const pad = PIECE.shadowPad;
      this.shadow.style.transform = place(
        xl - pad,
        -pad * 0.4,
        (xr - xl + pad * 2) / PIECE.shadowW,
        (h + pad * 1.6) / PIECE.shadowH,
      );
      this.fade(this.shadow, smoothstep(0.1, 0.7, open));
    }

    // Clip window: [bodyL, bodyR] x [0, h], made of boxes that only translate.
    if (this.clipB && this.clipL && this.clipR && this.content) {
      const shiftL = bodyL + CLIP.w / 2;
      const shiftR = bodyR - CLIP.w / 2 - shiftL;
      this.clipB.style.transform = `translate3d(0,${n(h - CLIP.h)}px,0)`;
      this.clipL.style.transform = `translate3d(${n(shiftL)}px,0,0)`;
      this.clipR.style.transform = `translate3d(${n(shiftR)}px,0,0)`;
      this.content.style.transform = `translate3d(${n(CLIP.w / 2 - bodyR)}px,${n(CLIP.h - h)}px,0)`;
    }

    // SurfaceRoot: shape first, chrome arrives late and leaves early.
    const chrome = smoothstep(MOTION.chromeIn[0], MOTION.chromeIn[1], open);
    this.fade(this.chrome, chrome);
    for (let i = 0; i < FACES.length; i++) {
      this.fade(this.faceEls[i], face[i]);
      this.fade(this.tabOn[i], face[i]);
    }
    if (this.grip) {
      this.grip.style.transform = `translate3d(${n(xr - spec.open.w / 2)}px,${n(h)}px,0)`;
    }
    if (this.tools) this.tools.style.transform = `translate3d(${n(xr - spec.open.w / 2)}px,0,0)`;

    // Closed chips live in the ears on both sides of the camera housing.
    this.fade(this.wings, 1 - smoothstep(MOTION.wingOut[0], MOTION.wingOut[1], open));
    const half = spec.housing.w / 2;
    const restH = spec.housing.h - REST_INSET;
    if (this.earLeft) this.earLeft.style.transform = place(-half - geo.earL / 2, restH / 2);
    if (this.earRight) this.earRight.style.transform = place(half + geo.earR / 2, restH / 2);
    for (let i = 0; i < ACTIVITIES.length; i++) {
      this.fade(this.chipsLeft[i], left[i]);
      this.fade(this.chipsRight[i], right[i]);
    }
  }

  // ----------------------------------------------------------- bookkeeping

  /** Publish the logical state on the element: attributes, hit target, events. */
  private commit(next: Logical, force: boolean, source: GoOptions['source'] = 'api') {
    const prev = this.logical;
    const changed =
      force || prev.state !== next.state || prev.left !== next.left || prev.right !== next.right;
    if (!changed) return;
    const from = prev.state;
    this.logical = { ...next };
    const parsed = parseState(next.state);
    if (parsed.face) this.currentFace = parsed.face;

    const root = this.root;
    root.dataset.state = next.state;
    root.dataset.face = this.currentFace;
    root.dataset.left = next.left ?? 'none';
    root.dataset.right = next.right ?? 'none';
    this.placeHit();
    if (this.hit) {
      const open = parsed.stance === 'open';
      this.hit.setAttribute('aria-expanded', String(open));
      this.hit.setAttribute(
        'aria-label',
        open ? 'Close the notch preview' : 'Open the notch preview',
      );
    }
    if (!force) {
      this.emit('notch:statechange', {
        state: next.state,
        from,
        face: this.currentFace,
        left: next.left,
        right: next.right,
        source,
      });
    }
  }

  /** The button that receives hover, click and keyboard focus sits on the closed lip. */
  private placeHit() {
    const hit = this.hit;
    if (!hit) return;
    const spec = this.spec;
    const stance = parseState(this.logical.state).stance;
    let x: number;
    let w: number;
    let h: number;
    if (stance === 'open') {
      // While open, only the camera housing closes the lip, so the face below stays clickable.
      x = -spec.housing.w / 2;
      w = spec.housing.w;
      h = spec.housing.h;
    } else {
      const { earL, earR } = this.earWidths(this.logical.left, this.logical.right);
      const grow = spec.peek.dw / 2 + 4;
      x = -(spec.housing.w / 2 + earL) - grow;
      w = spec.housing.w + earL + earR + grow * 2;
      h = spec.housing.h + spec.peek.dh + 6;
    }
    hit.style.width = `${n(w)}px`;
    hit.style.height = `${n(h)}px`;
    hit.style.transform = `translate3d(${n(x)}px,0,0)`;
  }

  private setBusy(on: boolean) {
    if (on) this.root.dataset.busy = 'true';
    else delete this.root.dataset.busy;
  }

  private emit(name: string, detail: Record<string, unknown> = {}) {
    this.root.dispatchEvent(new CustomEvent(name, { bubbles: true, detail: { notch: this, ...detail } }));
  }

  private setActive() {
    const active = this.inView && !document.hidden;
    if (active === !this.suspended) return;
    this.suspended = !active;
    for (const [animation, wasPlaying] of this.managed) {
      if (!active) {
        const playing = !animation.paused();
        this.managed.set(animation, playing);
        if (playing) animation.pause();
      } else if (wasPlaying) {
        animation.play();
        this.managed.set(animation, false);
      }
    }
    this.root.dataset.suspended = String(this.suspended);
  }

  private bind() {
    const root = this.root;
    const host = (root.offsetParent as HTMLElement | null) ?? root.parentElement;
    const on = <E extends Event = Event>(
      target: EventTarget,
      type: string,
      handler: (event: E) => void,
    ) => {
      target.addEventListener(type, handler as EventListener);
      this.cleanup.push(() => target.removeEventListener(type, handler as EventListener));
    };

    // Mode and fit follow the host's width.
    if (host && 'ResizeObserver' in window) {
      let frame = 0;
      const observer = new ResizeObserver(() => {
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(() => this.refresh());
      });
      observer.observe(host);
      this.cleanup.push(() => observer.disconnect());
    }

    // Animations pause when the notch is off screen or the tab is hidden.
    if (host && 'IntersectionObserver' in window) {
      const observer = new IntersectionObserver(
        (entries) => {
          this.inView = entries.some((entry) => entry.isIntersecting);
          this.setActive();
        },
        { rootMargin: '80px 0px' },
      );
      observer.observe(host);
      this.cleanup.push(() => observer.disconnect());
    }
    on(document, 'visibilitychange', () => this.setActive());

    // Reduced motion can be switched on while the page is open.
    on(this.reducedQuery, 'change', () => {
      if (this.reduced && this.tween) this.tween.progress(1);
      this.emit('notch:motionchange', { reduced: this.reduced });
    });

    if (!this.interactive) return;

    // Stance.swift: hover arms the lip, a click expands it, outside or Escape collapses it.
    const hit = this.hit;
    if (hit) {
      on(hit, 'pointerenter', (event: PointerEvent) => {
        if (event.pointerType === 'touch') return;
        if (this.logical.state === 'closed') {
          this.emit('notch:interact', { kind: 'hover' });
          this.setState('peek', { source: 'user' });
        }
      });
      on(hit, 'pointerleave', () => {
        if (this.logical.state === 'peek') this.setState('closed', { source: 'user' });
      });
      on(hit, 'click', () => {
        this.emit('notch:interact', { kind: 'click' });
        if (this.isOpen) this.setState('closed', { source: 'user' });
        else this.setState(`open:${this.currentFace}`, { source: 'user' });
      });
    }

    // The tab plates inside the open island switch faces, as in the app.
    on(root, 'click', (event: MouseEvent) => {
      const tab = (event.target as Element | null)?.closest<HTMLElement>('[data-island-tab]');
      const face = tab?.dataset.islandTab;
      if (!tab || !isFace(face) || !this.isOpen) return;
      this.emit('notch:interact', { kind: 'tab', face });
      this.setState(`open:${face}`, { source: 'user' });
    });

    on(document, 'pointerdown', (event: PointerEvent) => {
      if (!this.isOpen) return;
      const path = event.composedPath();
      if (path.includes(root)) return;
      const target = event.target as Element | null;
      if (target?.closest?.('[data-notch-keepopen]')) return;
      this.emit('notch:interact', { kind: 'outside' });
      this.setState('closed', { source: 'user' });
    });

    on(document, 'keydown', (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || this.logical.state === 'closed') return;
      this.emit('notch:interact', { kind: 'escape' });
      this.setState('closed', { source: 'user' });
    });
  }
}
