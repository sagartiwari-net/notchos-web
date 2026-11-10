import { Fragment } from 'react'
import { useMutation } from '@tanstack/react-query'
import { ChevronDownIcon, CircleUserIcon, FlaskConicalIcon, LogOutIcon } from 'lucide-react'
import { Link, useMatches } from 'react-router'
import { toast } from 'sonner'

import { dataSource, errorMessage, isNotSignedIn, logout, type Session } from '@/api'
import { queryClient, queryKeys } from '@/lib/query'
import { Badge } from '@/components/ui/badge'
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Separator } from '@/components/ui/separator'
import { SidebarTrigger } from '@/components/ui/sidebar'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { isRouteHandle, type Crumb } from '@/frame/nav'

/** Where the admin is. The last step is the page's heading. */
function Crumbs() {
  const matches = useMatches()
  let crumbs: Crumb[] = []
  for (const match of matches) {
    if (isRouteHandle(match.handle)) {
      crumbs = match.handle.crumbs(match.params)
    }
  }
  if (crumbs.length === 0) {
    return null
  }
  const parents = crumbs.slice(0, -1)
  const current = crumbs[crumbs.length - 1]

  return (
    <Breadcrumb className="min-w-0">
      <BreadcrumbList className="flex-nowrap">
        {parents.map((crumb) => (
          <Fragment key={crumb.label}>
            <BreadcrumbItem>
              {crumb.to === undefined ? (
                crumb.label
              ) : (
                <BreadcrumbLink asChild>
                  <Link to={crumb.to}>{crumb.label}</Link>
                </BreadcrumbLink>
              )}
            </BreadcrumbItem>
            <BreadcrumbSeparator />
          </Fragment>
        ))}
        <BreadcrumbItem className="min-w-0">
          <h1 className="truncate font-medium text-foreground" aria-current="page">
            {current.label}
          </h1>
        </BreadcrumbItem>
      </BreadcrumbList>
    </Breadcrumb>
  )
}

/** Says on every page that the numbers are not real, and how to see the other states. */
function MockDataBadge() {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge variant="warning" tabIndex={0} data-testid="mock-badge">
          <FlaskConicalIcon data-icon="inline-start" />
          Mock data
        </Badge>
      </TooltipTrigger>
      <TooltipContent side="bottom" align="end" className="max-w-72 flex-col items-start gap-1 py-2">
        <span>No server is connected. Everything shown is made-up sample data kept in memory.</span>
        <span>Changes you make last until the page is reloaded.</span>
        <span>
          Add ?mock=error, ?mock=empty or ?mock=slow to a page address to see its error, empty or loading
          state.
        </span>
      </TooltipContent>
    </Tooltip>
  )
}

function UserMenu({ session }: { session: Session }) {
  const signOut = useMutation({
    mutationFn: logout,
    // The route guard sees the empty session and shows the login screen.
    onSuccess: () => {
      queryClient.setQueryData<Session | null>(queryKeys.session, null)
    },
    onError: (error) => {
      // Already signed out on the server: the guard handles it, nothing to report.
      if (!isNotSignedIn(error)) {
        toast.error('Could not sign out', { description: errorMessage(error) })
      }
    },
  })

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" data-testid="user-menu">
          <CircleUserIcon data-icon="inline-start" />
          <span className="max-w-40 truncate">{session.admin.username}</span>
          <ChevronDownIcon data-icon="inline-end" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-44">
        <DropdownMenuGroup>
          <DropdownMenuLabel className="truncate">Signed in as {session.admin.username}</DropdownMenuLabel>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuItem disabled={signOut.isPending} onSelect={() => signOut.mutate()}>
            <LogOutIcon />
            Sign out
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function TopBar({ session }: { session: Session }) {
  return (
    <header className="sticky top-0 z-10 flex h-10 shrink-0 items-center gap-2 border-b bg-background px-3">
      <SidebarTrigger />
      <Separator orientation="vertical" className="data-vertical:h-4 data-vertical:self-center" />
      <Crumbs />
      <div className="ml-auto flex shrink-0 items-center gap-2">
        {dataSource === 'mock' && <MockDataBadge />}
        <UserMenu session={session} />
      </div>
    </header>
  )
}
