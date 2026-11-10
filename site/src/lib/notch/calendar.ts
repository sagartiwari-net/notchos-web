/**
 * Date helpers shared by the build (Astro frontmatter) and the browser (live.ts), so the
 * Calendar and Home faces always show the visitor's own "today".
 *
 * Mirrors Lumen/Sources/AgendaChrome.swift (MonthPane: Monday-first grid, W<week> pill) and
 * Lumen/Sources/SurfaceRoot.swift (FaceCopy.shortToday).
 */

export interface MonthCell {
  day: number;
  today: boolean;
  /** A small dot under the number: the day has an event or reminder. */
  marked: boolean;
}

export interface MonthModel {
  /** "November 2026" */
  label: string;
  /** "W46" */
  week: string;
  /** Always 42 slots (6 weeks). Empty slots are null. */
  cells: Array<MonthCell | null>;
  /** 5 or 6: how many week rows this month needs. */
  rows: number;
}

/** Days from today that carry sample events (see sampleAgenda). */
const MARK_OFFSETS = [2, 4];

/** ISO 8601 week number. */
export function isoWeek(date: Date): number {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
}

export function monthModel(now: Date, locale?: string): MonthModel {
  const year = now.getFullYear();
  const month = now.getMonth();
  const first = new Date(year, month, 1);
  const days = new Date(year, month + 1, 0).getDate();
  // Monday-first: Mon = 0 ... Sun = 6
  const lead = (first.getDay() + 6) % 7;
  const marks = new Set(
    MARK_OFFSETS.map((offset) => new Date(year, month, now.getDate() + offset))
      .filter((d) => d.getMonth() === month)
      .map((d) => d.getDate()),
  );
  const cells: Array<MonthCell | null> = [];
  for (let i = 0; i < 42; i++) {
    const day = i - lead + 1;
    cells.push(
      day >= 1 && day <= days
        ? { day, today: day === now.getDate(), marked: marks.has(day) }
        : null,
    );
  }
  return {
    label: new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric' }).format(now),
    week: `W${isoWeek(now)}`,
    cells,
    rows: Math.ceil((lead + days) / 7),
  };
}

/** FaceCopy.shortToday: "Tue 10 Nov". */
export function shortDate(date: Date, locale?: string): string {
  return new Intl.DateTimeFormat(locale, { weekday: 'short', day: 'numeric', month: 'short' })
    .format(date)
    .replace(',', '');
}

export function dayMonth(date: Date, locale?: string): string {
  return new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short' }).format(date);
}

export function clockTime(date: Date, locale?: string, timeZone?: string): string {
  return new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit', timeZone }).format(date);
}

/** Menu bar clock: "Tue 10 Nov" and "9:41 AM". */
export function menuBarClock(date: Date, locale?: string): { date: string; time: string } {
  return { date: shortDate(date, locale), time: clockTime(date, locale) };
}

export interface SampleAgenda {
  selected: string;
  todayEvent: string;
  todayReminder: string;
  upcomingEvent: string;
  upcomingReminder: string;
}

/** Sample events for the Calendar face, dated relative to today. Not real data. */
export function sampleAgenda(now: Date, locale?: string): SampleAgenda {
  const at = (offset: number, h: number, m: number) =>
    new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset, h, m);
  const span = (start: Date, end: Date) =>
    `${dayMonth(start, locale)} · ${clockTime(start, locale)} – ${clockTime(end, locale)}`;
  const due = (date: Date) =>
    `${new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', year: 'numeric' }).format(date)}, ${clockTime(date, locale)}`;
  return {
    selected: shortDate(now, locale),
    todayEvent: span(at(0, 15, 0), at(0, 15, 45)),
    todayReminder: due(at(0, 17, 0)),
    upcomingEvent: span(at(2, 12, 30), at(2, 13, 30)),
    upcomingReminder: due(at(4, 9, 0)),
  };
}
