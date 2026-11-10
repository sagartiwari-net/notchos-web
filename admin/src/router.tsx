import { createBrowserRouter } from 'react-router'

import { AppShell } from '@/frame/app-shell'
import type { RouteHandle } from '@/frame/nav'
import { RouteError } from '@/frame/route-error'
import { AuditLogPage } from '@/pages/audit-log-page'
import { DashboardPage } from '@/pages/dashboard-page'
import { EmailsPage } from '@/pages/emails-page'
import { LicenseDetailPage } from '@/pages/license-detail-page'
import { LicensesPage } from '@/pages/licenses-page'
import { LoginPage } from '@/pages/login-page'
import { NewLicensePage } from '@/pages/new-license-page'
import { NotFoundPage } from '@/pages/not-found-page'
import { SeatMovesPage } from '@/pages/seat-moves-page'
import { SettingsPage } from '@/pages/settings-page'
import { TrialLeadsPage } from '@/pages/trial-leads-page'
import { TrialsPage } from '@/pages/trials-page'

const LICENSES = { label: 'Licenses', to: '/licenses' }

const crumbs = {
  dashboard: { crumbs: () => [{ label: 'Dashboard' }] },
  licenses: { crumbs: () => [{ label: 'Licenses' }] },
  newLicense: { crumbs: () => [LICENSES, { label: 'New license' }] },
  license: { crumbs: (params) => [LICENSES, { label: `License #${params.id ?? ''}` }] },
  trials: { crumbs: () => [{ label: 'Trials' }] },
  trialLeads: { crumbs: () => [{ label: 'Trial leads' }] },
  seatMoves: { crumbs: () => [{ label: 'Seat moves' }] },
  emails: { crumbs: () => [{ label: 'Emails' }] },
  settings: { crumbs: () => [{ label: 'Settings' }] },
  audit: { crumbs: () => [{ label: 'Audit log' }] },
  notFound: { crumbs: () => [{ label: 'Page not found' }] },
} satisfies Record<string, RouteHandle>

/**
 * Real URLs for every page, so reload, Back and a copied link work. The built app is served
 * from the root of its own hostname; the web server must answer unknown paths with index.html.
 *
 * Everything except /login sits inside AppShell, which is also the signed-out guard.
 * Payments and Webhooks have no route yet (phase W3): their addresses show the not-found page.
 */
// Vite `base` is `/` locally and `/admin/` on the temporary same-domain deploy.
const basename = (import.meta.env.BASE_URL || '/').replace(/\/$/, '') || undefined

export const router = createBrowserRouter(
  [
    {
      path: '/login',
      element: <LoginPage />,
      errorElement: <RouteError />,
    },
    {
      element: <AppShell />,
      errorElement: <RouteError />,
      children: [
        { index: true, element: <DashboardPage />, handle: crumbs.dashboard },
        { path: 'licenses', element: <LicensesPage />, handle: crumbs.licenses },
        { path: 'licenses/new', element: <NewLicensePage />, handle: crumbs.newLicense },
        { path: 'licenses/:id', element: <LicenseDetailPage />, handle: crumbs.license },
        { path: 'trials', element: <TrialsPage />, handle: crumbs.trials },
        { path: 'trial-leads', element: <TrialLeadsPage />, handle: crumbs.trialLeads },
        { path: 'seat-moves', element: <SeatMovesPage />, handle: crumbs.seatMoves },
        { path: 'emails', element: <EmailsPage />, handle: crumbs.emails },
        { path: 'settings', element: <SettingsPage />, handle: crumbs.settings },
        { path: 'audit', element: <AuditLogPage />, handle: crumbs.audit },
        { path: '*', element: <NotFoundPage />, handle: crumbs.notFound },
      ],
    },
  ],
  basename ? { basename } : undefined,
)
