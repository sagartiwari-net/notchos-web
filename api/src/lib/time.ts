// Time handling for the whole API.
//
// Rules:
//   * Every instant is UTC with whole-second precision.
//   * The API's clock is the only source of "now". SQL never calls NOW(); the current
//     time is passed as a parameter, so tests can run on a fake clock.
//   * On the wire (token fields, server_time, every date in a JSON answer) a date is an
//     ISO 8601 string in UTC with seconds and a trailing Z: 2026-11-10T03:00:00Z.
//     No fractional seconds, no offsets, always 20 characters.

export interface Clock {
  /** Current time, truncated to whole seconds. Always a fresh Date object. */
  now(): Date;
}

export const systemClock: Clock = {
  now: () => truncateToSeconds(new Date()),
};

export function truncateToSeconds(date: Date): Date {
  return new Date(Math.floor(date.getTime() / 1000) * 1000);
}

/** The wire encoding of a date: 2026-11-10T03:00:00Z. */
export function toIso(date: Date): string {
  return `${date.toISOString().slice(0, 19)}Z`;
}

export function toIsoOrNull(date: Date | null): string | null {
  return date === null ? null : toIso(date);
}

export function addSeconds(date: Date, seconds: number): Date {
  return new Date(date.getTime() + seconds * 1000);
}

export function addDays(date: Date, days: number): Date {
  return addSeconds(date, days * 86_400);
}
