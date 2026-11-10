import type { ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router'

import { getDashboard, type DashboardCounters } from '@/api'
import { ErrorState, RefreshFailedNotice } from '@/components/data-states'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { usePageTitle } from '@/hooks/use-page-title'
import { formatCount, formatMoney, formatShare, localMidnightIso, localUtcOffset } from '@/lib/format'
import { plural } from '@/lib/labels'
import { queryKeys } from '@/lib/query'
import { cn } from '@/lib/utils'

interface StatProps {
  label: string
  value: ReactNode
  /** One short line under the number. */
  hint?: ReactNode
  /** 'attention' colours the number when something is waiting for the admin. */
  tone?: 'default' | 'attention'
  testId?: string
}

function Stat({ label, value, hint, tone = 'default', testId }: StatProps) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5 bg-card px-3 py-2.5">
      <dt className="truncate text-xs text-muted-foreground">{label}</dt>
      <dd
        className={cn('text-xl/7 font-medium tabular-nums', tone === 'attention' && 'text-warning')}
        data-testid={testId}
      >
        {value}
      </dd>
      {hint !== undefined && <dd className="truncate text-xs text-muted-foreground">{hint}</dd>}
    </div>
  )
}

interface StatGroupProps {
  title: string
  description?: ReactNode
  /** A link in the corner of the group. */
  action?: ReactNode
  footer?: ReactNode
  children: ReactNode
}

/** Three numbers that belong together, in one bordered row. */
function StatGroup({ title, description, action, footer, children }: StatGroupProps) {
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>
          <h2>{title}</h2>
        </CardTitle>
        {description !== undefined && <CardDescription>{description}</CardDescription>}
        {action !== undefined && <CardAction>{action}</CardAction>}
      </CardHeader>
      <CardContent>
        <dl className="grid grid-cols-3 gap-px overflow-hidden rounded-md border bg-border">{children}</dl>
      </CardContent>
      {footer !== undefined && <CardFooter className="text-xs text-muted-foreground">{footer}</CardFooter>}
    </Card>
  )
}

function payments(count: number): string {
  return `${formatCount(count)} ${plural(count, 'payment', 'payments')}`
}

function Counters({ data }: { data: DashboardCounters }) {
  const { sales, active_licenses: active, trials } = data
  const money = (amount: string) => formatMoney(amount, data.currency)

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <StatGroup
        title="Sales"
        description={`Completed payments in ${data.currency}. Today starts at midnight your time (${localUtcOffset()}).`}
      >
        <Stat label="Today" value={money(sales.today.amount)} hint={payments(sales.today.count)} testId="sales-today" />
        <Stat label="Last 7 days" value={money(sales.last_7_days.amount)} hint={payments(sales.last_7_days.count)} />
        <Stat label="Last 30 days" value={money(sales.last_30_days.amount)} hint={payments(sales.last_30_days.count)} />
      </StatGroup>

      <StatGroup
        title="Active licenses"
        description="Not revoked and not expired."
        action={
          <Button variant="link" size="sm" asChild>
            <Link to="/licenses?state=active">View licenses</Link>
          </Button>
        }
      >
        <Stat label="Monthly" value={formatCount(active.monthly)} hint="active now" testId="active-monthly" />
        <Stat label="Lifetime" value={formatCount(active.lifetime)} hint="active now" testId="active-lifetime" />
        <Stat
          label="Monthly subscribers"
          value={formatCount(data.monthly_subscribers)}
          hint="auto-renew is on"
          testId="monthly-subscribers"
        />
      </StatGroup>

      <StatGroup
        title="Trials"
        description="Free trials started inside the app, one per Mac."
        action={
          <Button variant="link" size="sm" asChild>
            <Link to="/trials">View trials</Link>
          </Button>
        }
        footer={
          trials.started_total === 0
            ? 'No trial has been started yet.'
            : `All time: ${formatCount(trials.started_total)} started, ${formatCount(trials.converted_total)} converted (${formatShare(trials.converted_total, trials.started_total)}).`
        }
      >
        <Stat label="On trial now" value={formatCount(trials.active)} hint="not ended yet" testId="trials-active" />
        <Stat label="Started" value={formatCount(trials.started_30_days)} hint="last 30 days" />
        <Stat
          label="Converted"
          value={formatCount(trials.converted_30_days)}
          hint={
            trials.started_30_days === 0
              ? 'of those started'
              : `${formatShare(trials.converted_30_days, trials.started_30_days)} of those started`
          }
        />
      </StatGroup>

      <StatGroup
        title="Needs attention"
        description="Things that wait for you."
        footer="The Emails, Webhooks and Payments pages that list these arrive in phase W3."
      >
        <Stat
          label="Emails"
          value={formatCount(data.failed_emails)}
          hint="failed to send"
          tone={data.failed_emails > 0 ? 'attention' : 'default'}
        />
        <Stat
          label="Webhooks"
          value={formatCount(data.unprocessed_webhooks)}
          hint="not processed"
          tone={data.unprocessed_webhooks > 0 ? 'attention' : 'default'}
        />
        <Stat
          label="Disputes"
          value={formatCount(data.open_disputes)}
          hint="open at PayPal"
          tone={data.open_disputes > 0 ? 'attention' : 'default'}
        />
      </StatGroup>
    </div>
  )
}

function CountersSkeleton() {
  return (
    <div className="grid gap-4 lg:grid-cols-2" aria-busy="true" aria-label="Loading the dashboard">
      {[0, 1, 2, 3].map((group) => (
        <Card key={group} size="sm">
          <CardHeader>
            <Skeleton className="h-4 w-28" />
            <Skeleton className="h-3 w-56" />
          </CardHeader>
          <CardContent>
            <Skeleton className="h-[4.75rem] w-full" />
          </CardContent>
        </Card>
      ))}
    </div>
  )
}

export function DashboardPage() {
  usePageTitle('Dashboard')
  const dashboard = useQuery({
    queryKey: queryKeys.dashboard,
    queryFn: () => getDashboard({ today_start: localMidnightIso() }),
  })

  if (dashboard.data === undefined) {
    if (dashboard.isError) {
      return (
        <ErrorState
          title="Could not load the dashboard"
          error={dashboard.error}
          onRetry={() => void dashboard.refetch()}
          retrying={dashboard.isFetching}
        />
      )
    }
    return <CountersSkeleton />
  }
  return (
    <>
      {dashboard.isError && (
        <RefreshFailedNotice
          error={dashboard.error}
          onRetry={() => void dashboard.refetch()}
          retrying={dashboard.isFetching}
        />
      )}
      <Counters data={dashboard.data} />
    </>
  )
}
