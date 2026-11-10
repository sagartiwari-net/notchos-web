// Which dates go into a token (NOTCHOS-LICENSE-PLAN.md section 4).
//
//   plan      expires_at                 refresh_by
//   lifetime  null                       issued + 30 days (rolling: every refresh moves it)
//   monthly   the license's expires_at   the same date
//   trial     trial start + trial days   the same date
//
// issued_at is always the server's clock at the moment of signing. It is inside the
// signature, so the app can treat it as a trusted "it is at least this late".

import type { TokenPlan, TokenSigner } from '../crypto/signing.ts';
import { addDays, toIso, toIsoOrNull } from '../lib/time.ts';

/** A lifetime token must be refreshed online within this many days. */
export const LIFETIME_REFRESH_DAYS = 30;

export interface IssuedToken {
  token: string;
  plan: TokenPlan;
  expiresAt: Date | null;
  refreshBy: Date;
}

export function issueLicenseToken(
  signer: TokenSigner,
  license: { id: number; plan: 'monthly' | 'lifetime'; expires_at: Date | null },
  deviceId: string,
  now: Date,
): IssuedToken {
  const expiresAt = license.expires_at;
  const refreshBy = expiresAt === null ? addDays(now, LIFETIME_REFRESH_DAYS) : expiresAt;
  const token = signer.issue({
    license_id: license.id,
    device_id: deviceId,
    plan: license.plan,
    issued_at: toIso(now),
    expires_at: toIsoOrNull(expiresAt),
    refresh_by: toIso(refreshBy),
  });
  return { token, plan: license.plan, expiresAt, refreshBy };
}

export function issueTrialToken(
  signer: TokenSigner,
  trial: { expires_at: Date },
  deviceId: string,
  now: Date,
): IssuedToken {
  const token = signer.issue({
    license_id: null,
    device_id: deviceId,
    plan: 'trial',
    issued_at: toIso(now),
    expires_at: toIso(trial.expires_at),
    refresh_by: toIso(trial.expires_at),
  });
  return { token, plan: 'trial', expiresAt: trial.expires_at, refreshBy: trial.expires_at };
}
