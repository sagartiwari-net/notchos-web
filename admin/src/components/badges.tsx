import type { LicensePlan, LicenseState, TrialState } from '@/api'
import { PLAN_LABEL, STATE_LABEL, TRIAL_STATE_LABEL } from '@/lib/labels'
import { Badge } from '@/components/ui/badge'

/** Active, Expired or Revoked: what the license is worth right now. */
export function StateBadge({ state }: { state: LicenseState }) {
  const variant = state === 'active' ? 'success' : state === 'expired' ? 'warning' : 'destructive'
  return <Badge variant={variant}>{STATE_LABEL[state]}</Badge>
}

export function PlanBadge({ plan }: { plan: LicensePlan }) {
  return <Badge variant="outline">{PLAN_LABEL[plan]}</Badge>
}

export function TrialStateBadge({ state }: { state: TrialState }) {
  return <Badge variant={state === 'active' ? 'success' : 'secondary'}>{TRIAL_STATE_LABEL[state]}</Badge>
}
