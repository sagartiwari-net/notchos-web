/**
 * Island geometry and motion, ported from the Mac app (read-only source of truth):
 *
 *   Lumen/Sources/ShelfBin.swift     ShelfFace.minimumOpen / preferredOpen  -> open size per face
 *   Lumen/Sources/ScreenShell.swift  lipBox (corner radii), morphDurationSeconds, morphEase
 *   Lumen/Sources/SurfaceRoot.swift  lipPath (outline), chrome / wing fades, tab bar order
 *   Lumen/Sources/DisplaySpan.swift  resting lip = camera housing, one point short
 *   Lumen/Sources/GlanceHub.swift    closed "ears": width per live activity, ear padding
 *   Lumen/Sources/DesignTokens.swift NotchMotion
 *   Lumen/Sources/Stance.swift       compact / hoverArmed / expanded
 *
 * 1 point in the app = 1 CSS pixel here.
 */

export const FACES = [
  'home',
  'tray',
  'tools',
  'android',
  'translate',
  'timers',
  'prompter',
  'tasks',
  'calendar',
  'clipboard',
  'system',
  'ai',
] as const;

export type Face = (typeof FACES)[number];

export const FACE_LABEL: Record<Face, string> = {
  home: 'Home',
  tray: 'Tray',
  tools: 'Tools',
  android: 'Android Share',
  translate: 'Translate',
  timers: 'Timers',
  prompter: 'Prompter',
  tasks: 'Tasks',
  calendar: 'Calendar',
  clipboard: 'Clipboard',
  system: 'System',
  ai: 'AI',
};

/** Tab order inside the island — matches Lumen LipTabStrip. */
export const ISLAND_TABS: readonly Face[] = [
  'home',
  'tray',
  'tools',
  'android',
  'translate',
  'timers',
  'prompter',
  'tasks',
  'calendar',
  'clipboard',
  'system',
  'ai',
];

export type Mode = 'wide' | 'compact';

export interface ModeSpec {
  /** Camera housing drawn at the top centre of the screen. */
  housing: { w: number; h: number };
  /** Closed lip corners: ScreenShell.lipBox, upper 7 / lower 12. */
  rest: { u: number; l: number };
  /** Hover. The app only arms a 120 ms dwell here; the page shows a small swell (web only). */
  peek: { dw: number; dh: number; u: number; l: number };
  /** Open lip: width and corners (upper 18 / lower 28). */
  open: { w: number; u: number; l: number };
  /** Open height per face. */
  faces: Record<Face, number>;
  /** GlanceHub.earPad: inset from the housing edge and from the outer lip edge. */
  earPad: number;
  /** Content width each closed chip asks for. The ear adds earPad on both sides. */
  extra: Record<Activity, number>;
  /** GlanceHub.earWidth: an empty balance ear never grows past this. */
  balanceMax: number;
}

export const MODE_SPECS: Record<Mode, ModeSpec> = {
  /** Current app sizes: ShelfFace.preferredOpen ~860–960 wide, faceOpenHeight 320. */
  wide: {
    // The app measures the real cutout (about 185 x 32 pt on a 14-inch MacBook Pro).
    // 184 keeps every edge on a whole pixel around the centre line.
    housing: { w: 184, h: 32 },
    rest: { u: 7, l: 12 },
    peek: { dw: 16, dh: 6, u: 8, l: 14 },
    open: { w: 900, u: 18, l: 28 },
    earPad: 10,
    // GlanceSlot.wingExtra, from GlanceHub.persistentRanked and pushHUD.
    extra: {
      music: 88, // TuneDeck.recomputeWing
      timer: 96, // ClockDeck.refreshWing
      download: 64, // n <= 9
      battery: 68, // pushHUD(.battery)
      meeting: 78, // 58 + min(title.count, 10) * 2
      transfer: 126, // pushHUD(.nearby(name)): 86 + max(name.count, 4) * 5, name = "Clip.mov"
      shelf: 56, // n <= 9
    },
    balanceMax: 84,
    faces: {
      home: 300,
      tray: 320,
      tools: 320,
      android: 320,
      translate: 320,
      timers: 320,
      prompter: 320,
      tasks: 320,
      calendar: 320,
      clipboard: 320,
      system: 320,
      ai: 320,
    },
  },
  /**
   * Phone width. The app has no layout this narrow (its floor is 420 pt), so this is a web-only
   * reflow of the same faces: one column, same chrome, same tokens.
   */
  compact: {
    housing: { w: 118, h: 26 },
    rest: { u: 6, l: 10 },
    peek: { dw: 12, dh: 5, u: 7, l: 12 },
    open: { w: 340, u: 12, l: 24 },
    earPad: 8,
    // The app's widths leave air that a 360 px screen does not have: here each chip gets
    // what it measures (music 39, timer 56, download 30, battery 65, meeting 45, file name 64,
    // shelf 26) and a few pixels.
    extra: {
      music: 42,
      timer: 58,
      download: 32,
      battery: 66,
      meeting: 48,
      transfer: 66,
      shelf: 28,
    },
    balanceMax: 40,
    faces: {
      home: 290,
      tray: 310,
      tools: 320,
      android: 320,
      translate: 320,
      timers: 320,
      prompter: 330,
      tasks: 340,
      calendar: 360,
      clipboard: 340,
      system: 340,
      ai: 360,
    },
  },
};

/** NotchHairline.width */
export const HAIRLINE = 0.8;

/** Resting lip is the housing, one point short so it stays inside the cutout (DisplaySpan.resting). */
export const REST_INSET = 1;

/** Sliding clip window that hides face content outside the island while it morphs. */
export const CLIP = { w: 960, h: 600 };

/**
 * Base sizes of the scaled lip pieces. They must match src/styles/notch.css.
 * The body and the floor are flat colour, so they are small and scaled up (a flat colour does
 * not blur). The corners and flares are curves, so they are drawn at their largest size and
 * only ever scaled down.
 */
export const PIECE = {
  coreW: 100,
  coreH: 100,
  floorW: 100,
  floorH: 40,
  corner: 40,
  flare: 24,
  flareOverlap: 4,
  glossW: 100,
  shadowW: 400,
  shadowH: 300,
  shadowPad: 46,
};

export const MOTION = {
  /** ScreenShell.morphDurationSeconds, MotionStyle.spring (the app default). */
  island: 0.36,
  /** ScreenShell.morphEase: cubic ease-in-out, identical open and close. */
  islandEase: 'power2.inOut',
  /** Peek / chip changes: 0.20 s, cubic ease-out. */
  peek: 0.2,
  peekEase: 'power2.out',
  /** Face to face with no size change: NotchMotion.content + pane crossfade. */
  swap: 0.26,
  /** Closed ear grows or shrinks for a new live activity. */
  wing: 0.3,
  /** NotchMotion.pulsePeriod / pulseOpacityMin */
  pulsePeriod: 2,
  pulseMin: 0.72,
  /**
   * SurfaceRoot fades the chrome in between 58 % and 90 % of the reveal. The app lays the face
   * out again on every frame of the morph; here the face keeps its final layout behind a clip
   * window (no layout while animating), so it comes in a little later, when less of it is cut.
   */
  chromeIn: [0.66, 0.94] as const,
  /** SurfaceRoot: closed chips are gone once the lip has opened 8 %. */
  wingOut: [0.02, 0.1] as const,
};

export const ACTIVITIES = [
  'music',
  'timer',
  'download',
  'battery',
  'meeting',
  'transfer',
  'shelf',
] as const;

export type Activity = (typeof ACTIVITIES)[number];

export function isFace(value: unknown): value is Face {
  return typeof value === 'string' && (FACES as readonly string[]).includes(value);
}

export function isActivity(value: unknown): value is Activity {
  return typeof value === 'string' && (ACTIVITIES as readonly string[]).includes(value);
}
