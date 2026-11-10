import {
  ArrowRightLeftIcon,
  CirclePlusIcon,
  CreditCardIcon,
  HourglassIcon,
  KeyRoundIcon,
  LayoutDashboardIcon,
  MailIcon,
  ScrollTextIcon,
  SettingsIcon,
  WebhookIcon,
  type LucideIcon,
} from 'lucide-react'

export interface NavItem {
  title: string
  icon: LucideIcon
  /** Where the item goes. Absent for pages that are not built yet. */
  to?: string
  /** Whether this item is the current page. Defaults to an exact match of `to`. */
  isCurrent?: (pathname: string) => boolean
  /** For pages that are not built yet: the phase that brings them. */
  arrivesIn?: string
}

export interface NavGroup {
  label: string
  items: NavItem[]
}

/**
 * The pages of plan section 8. Payments and Webhooks arrive in phase W3: they are listed
 * so the sidebar already has its final shape, but they are not links. Emails is live.
 */
export const NAV_GROUPS: NavGroup[] = [
  {
    label: 'Overview',
    items: [{ title: 'Dashboard', icon: LayoutDashboardIcon, to: '/' }],
  },
  {
    label: 'Licensing',
    items: [
      {
        title: 'Licenses',
        icon: KeyRoundIcon,
        to: '/licenses',
        // The list and every license detail, but not the New license form.
        isCurrent: (pathname) =>
          pathname === '/licenses' || (pathname.startsWith('/licenses/') && pathname !== '/licenses/new'),
      },
      { title: 'New license', icon: CirclePlusIcon, to: '/licenses/new' },
      { title: 'Trials', icon: HourglassIcon, to: '/trials' },
      { title: 'Trial leads', icon: MailIcon, to: '/trial-leads' },
      {
        title: 'Seat moves',
        icon: ArrowRightLeftIcon,
        to: '/seat-moves',
      },
    ],
  },
  {
    label: 'PayPal and email',
    items: [
      { title: 'Payments', icon: CreditCardIcon, arrivesIn: 'W3' },
      { title: 'Webhooks', icon: WebhookIcon, arrivesIn: 'W3' },
      { title: 'Emails', icon: MailIcon, to: '/emails' },
    ],
  },
  {
    label: 'System',
    items: [
      { title: 'Settings', icon: SettingsIcon, to: '/settings' },
      { title: 'Audit log', icon: ScrollTextIcon, to: '/audit' },
    ],
  },
]

/** One step of the breadcrumb in the top bar. The last one is the page title. */
export interface Crumb {
  label: string
  to?: string
}

/** Put on a route as `handle` so the top bar can show where the admin is. */
export interface RouteHandle {
  crumbs: (params: Readonly<Record<string, string | undefined>>) => Crumb[]
}

export function isRouteHandle(handle: unknown): handle is RouteHandle {
  return typeof handle === 'object' && handle !== null && typeof (handle as RouteHandle).crumbs === 'function'
}

/**
 * Where to go after signing in. Only paths inside this app are accepted, so a crafted
 * ?next= cannot send the admin to another site.
 */
export function safeNextPath(raw: string | null): string {
  if (
    raw === null ||
    !raw.startsWith('/') ||
    raw.startsWith('//') ||
    raw.startsWith('/\\') ||
    raw === '/login' ||
    raw.startsWith('/login?') ||
    raw.startsWith('/login/')
  ) {
    return '/'
  }
  return raw
}

/** The login URL that brings the admin back to `path` afterwards. */
export function loginPathFor(path: string): string {
  return path === '/' ? '/login' : `/login?next=${encodeURIComponent(path)}`
}
