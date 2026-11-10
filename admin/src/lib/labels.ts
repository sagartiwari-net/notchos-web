import type { LicenseEventType, LicensePlan, LicenseSource, LicenseState, TrialState } from '@/api'

export const PLAN_LABEL: Record<LicensePlan, string> = {
  monthly: 'Monthly',
  lifetime: 'Lifetime',
}

export const STATE_LABEL: Record<LicenseState, string> = {
  active: 'Active',
  expired: 'Expired',
  revoked: 'Revoked',
}

export const SOURCE_LABEL: Record<LicenseSource, string> = {
  paypal: 'PayPal',
  manual: 'Manual',
}

export const TRIAL_STATE_LABEL: Record<TrialState, string> = {
  active: 'On trial',
  ended: 'Ended',
}

const EVENT_LABEL: Record<LicenseEventType, string> = {
  activate: 'Activate',
  refresh: 'Refresh',
  deny: 'Deny',
  transfer: 'Transfer',
  deactivate: 'Deactivate',
  revoke: 'Revoke',
  renew: 'Renew',
  trial: 'Trial',
}

/** The name of an event type; a type this build does not know is shown as it is. */
export function eventLabel(type: string): string {
  return (EVENT_LABEL as Record<string, string | undefined>)[type] ?? type
}

/** What to call a Mac that sent no name. */
export const UNNAMED_MAC = 'Unnamed Mac'

const ACTION_LABEL: Record<string, string> = {
  login: 'Signed in',
  logout: 'Signed out',
  'license.create': 'Created license',
  'license.revoke': 'Revoked license',
  'license.restore': 'Restored license',
  'license.free_seat': 'Freed seat',
  'license.extend': 'Extended license',
  'license.change_plan': 'Changed plan',
  'license.set_max_devices': 'Changed Macs allowed',
  'license.resend_key': 'Resent key',
  'license.reveal_key': 'Revealed key',
  'license.change_email': 'Changed email',
  'license.set_note': 'Edited note',
  'trial.grant': 'Started trial',
  'trial.reset': 'Reset trial',
  'settings.update': 'Changed settings',
}

/** Plain words for an audit action; an action this build does not know is shown as it is. */
export function actionLabel(action: string): string {
  return ACTION_LABEL[action] ?? action
}

/** The license id inside an audit target such as "license:42", or null. */
export function licenseIdOfTarget(target: string | null): number | null {
  const match = target === null ? null : /^license:(\d+)$/.exec(target)
  return match === null ? null : Number(match[1])
}

export function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many
}
