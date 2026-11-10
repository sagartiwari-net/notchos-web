// Values the admin can change, stored in the settings table as text.

import type { Queryable } from '../db/pool.ts';
import { selectOne } from '../db/pool.ts';

/** Defaults used when a setting is missing or not a sensible number. */
export const SETTING_DEFAULTS = {
  trial_days: 7,
  transfer_limit: 2,
  renewal_buffer_hours: 24,
} as const;

export type NumericSetting = keyof typeof SETTING_DEFAULTS;

export const SETTING_RANGE: Record<NumericSetting, { min: number; max: number }> = {
  trial_days: { min: 1, max: 365 },
  transfer_limit: { min: 0, max: 1000 },
  renewal_buffer_hours: { min: 0, max: 24 * 30 },
};

/** A whole-number setting; the default when the row is missing or its value is out of range. */
export async function getNumericSetting(q: Queryable, name: NumericSetting): Promise<number> {
  const row = await selectOne<{ value: string }>(q, 'SELECT value FROM settings WHERE name = ?', [name]);
  if (row === null || !/^\d{1,9}$/.test(row.value.trim())) return SETTING_DEFAULTS[name];
  const value = Number(row.value.trim());
  const { min, max } = SETTING_RANGE[name];
  return value >= min && value <= max ? value : SETTING_DEFAULTS[name];
}
