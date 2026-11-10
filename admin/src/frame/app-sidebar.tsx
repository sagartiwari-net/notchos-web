import { Link, useLocation } from 'react-router'

import { NotchMark } from '@/components/notch-mark'
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from '@/components/ui/sidebar'
import { NAV_GROUPS, type NavItem } from '@/frame/nav'

function NavEntry({ item, pathname }: { item: NavItem; pathname: string }) {
  const Icon = item.icon

  // A page that is not built yet: shown so the sidebar has its final shape, but not a link.
  if (item.to === undefined) {
    return (
      <SidebarMenuItem
        title={`${item.title} is not available yet. It arrives in phase ${item.arrivesIn ?? 'W3'}.`}
        data-nav-unavailable={item.title}
      >
        <SidebarMenuButton disabled>
          <Icon />
          <span className="flex-1 truncate">{item.title}</span>
          <span>{item.arrivesIn}</span>
        </SidebarMenuButton>
      </SidebarMenuItem>
    )
  }

  const current = item.isCurrent === undefined ? pathname === item.to : item.isCurrent(pathname)
  return (
    <SidebarMenuItem>
      <SidebarMenuButton asChild isActive={current} tooltip={item.title}>
        <Link to={item.to} aria-current={current ? 'page' : undefined}>
          <Icon />
          <span>{item.title}</span>
        </Link>
      </SidebarMenuButton>
    </SidebarMenuItem>
  )
}

export function AppSidebar() {
  const { pathname } = useLocation()

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" asChild tooltip="NotchOS Admin">
              <Link to="/">
                <span className="flex aspect-square size-8 items-center justify-center rounded-md border bg-background">
                  <NotchMark />
                </span>
                <span className="grid flex-1 leading-tight">
                  <span className="truncate text-sm font-medium">NotchOS</span>
                  <span className="truncate text-muted-foreground">Admin</span>
                </span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        {NAV_GROUPS.map((group) => (
          <SidebarGroup key={group.label}>
            <SidebarGroupLabel>{group.label}</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {group.items.map((item) => (
                  <NavEntry key={item.title} item={item} pathname={pathname} />
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}
      </SidebarContent>
      <SidebarRail />
    </Sidebar>
  )
}
