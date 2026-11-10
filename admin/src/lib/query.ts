import { MutationCache, QueryCache, QueryClient, useQuery } from '@tanstack/react-query'

import {
  getSession,
  isNotSignedIn,
  type AuditLogParams,
  type LicenseListParams,
  type Session,
  type TrialListParams,
} from '@/api'
import { forgetAllCreatedKeys } from '@/lib/created-keys'

/** Cache keys, one place so pages and invalidations cannot drift apart. */
export const queryKeys = {
  session: ['session'] as const,
  dashboard: ['dashboard'] as const,
  /** Prefix of every licenses list, whatever its filters. */
  licenseLists: ['licenses'] as const,
  licenseList: (params: LicenseListParams) => ['licenses', params] as const,
  license: (id: number) => ['license', id] as const,
  /** Prefix of every trials list, whatever its filters. */
  trialLists: ['trials'] as const,
  trialList: (params: TrialListParams) => ['trials', params] as const,
  trialLeadLists: ['trial-leads'] as const,
  trialLeadList: (params: { q?: string; page?: number; page_size?: number }) =>
    ['trial-leads', params] as const,
  seatMoveLists: ['seat-moves'] as const,
  seatMoveList: (params: { q?: string; page?: number; page_size?: number }) =>
    ['seat-moves', params] as const,
  settings: ['settings'] as const,
  auditLogs: ['audit-log'] as const,
  auditLog: (params: AuditLogParams) => ['audit-log', params] as const,
}

/**
 * A not-signed-in answer from any call ends the session in the app: the session query
 * becomes null, and the route guard sends the admin to the login screen (and back to the
 * same page after signing in).
 */
function onCallFailed(error: unknown): void {
  if (isNotSignedIn(error)) {
    queryClient.setQueryData<Session | null>(queryKeys.session, null)
  }
}

export const queryClient = new QueryClient({
  queryCache: new QueryCache({ onError: onCallFailed }),
  mutationCache: new MutationCache({ onError: onCallFailed }),
  defaultOptions: {
    queries: {
      // Errors go straight to the page's error state, which has its own Retry button.
      retry: false,
    },
    mutations: {
      retry: false,
    },
  },
})

/** The signed-in admin: a Session, null when signed out, undefined while the first check runs. */
export function useSession() {
  return useQuery({
    queryKey: queryKeys.session,
    queryFn: getSession,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  })
}

/** Drops everything that was loaded for the previous session. Called while signed out. */
export function clearCachedData(): void {
  queryClient.removeQueries({ predicate: (query) => query.queryKey[0] !== queryKeys.session[0] })
  queryClient.getMutationCache().clear()
  forgetAllCreatedKeys()
}

/** After a license changed: lists, counters and the audit log are out of date. */
export function invalidateAfterLicenseChange(): void {
  void queryClient.invalidateQueries({ queryKey: queryKeys.licenseLists })
  void queryClient.invalidateQueries({ queryKey: queryKeys.dashboard })
  void queryClient.invalidateQueries({ queryKey: queryKeys.auditLogs })
}

/** After a trial was started or looked up from admin: lists, counters and the audit log. */
export function invalidateAfterTrialChange(): void {
  void queryClient.invalidateQueries({ queryKey: queryKeys.trialLists })
  void queryClient.invalidateQueries({ queryKey: queryKeys.dashboard })
  void queryClient.invalidateQueries({ queryKey: queryKeys.auditLogs })
}
