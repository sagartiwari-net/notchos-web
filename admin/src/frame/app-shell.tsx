import type { CSSProperties } from 'react'
import { Navigate, Outlet, useLocation } from 'react-router'

import { ErrorState, FullPageSpinner } from '@/components/data-states'
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar'
import { AppSidebar } from '@/frame/app-sidebar'
import { loginPathFor } from '@/frame/nav'
import { TopBar } from '@/frame/top-bar'
import { useSession } from '@/lib/query'

/** The sidebar component remembers open/closed in this cookie; read it back on load. */
function sidebarStartsOpen(): boolean {
  return !document.cookie.split('; ').includes('sidebar_state=false')
}

// Narrower than the stock 16rem so tables keep their width at 1280 px.
const SIDEBAR_STYLE = { '--sidebar-width': '13.5rem' } as CSSProperties

/**
 * The frame around every signed-in page: sidebar, top bar, page content.
 * It is also the route guard. Signed out (at load, or when any call answers not_signed_in)
 * it sends the admin to the login screen and remembers the page to come back to.
 */
export function AppShell() {
  const session = useSession()
  const location = useLocation()

  if (session.isPending) {
    return <FullPageSpinner label="Checking your session" />
  }

  if (session.isError) {
    // The API did not answer, so the app cannot know whether anyone is signed in.
    return (
      <div className="flex min-h-svh items-center justify-center p-6">
        <ErrorState
          className="max-w-md"
          title="Could not reach the admin API"
          error={session.error}
          onRetry={() => void session.refetch()}
          retrying={session.isFetching}
        />
      </div>
    )
  }

  if (session.data === null) {
    return <Navigate to={loginPathFor(location.pathname + location.search)} replace />
  }

  return (
    <SidebarProvider defaultOpen={sidebarStartsOpen()} style={SIDEBAR_STYLE}>
      <AppSidebar />
      <SidebarInset className="min-w-0">
        <TopBar session={session.data} />
        <div className="flex min-w-0 flex-1 flex-col gap-4 p-4">
          <Outlet />
        </div>
      </SidebarInset>
    </SidebarProvider>
  )
}
