import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { ClockIcon, FilterXIcon, KeyRoundIcon, PlusIcon, RepeatIcon, SearchXIcon } from 'lucide-react'
import { Link, useNavigate } from 'react-router'

import {
  EXPIRING_SOON_DAYS,
  listLicenses,
  type LicenseListItem,
  type LicenseListParams,
  type LicensePlan,
  type LicenseState,
} from '@/api'
import { PlanBadge, StateBadge } from '@/components/badges'
import { EmptyState, ErrorState, RefreshFailedNotice, SkeletonRows } from '@/components/data-states'
import { Pager } from '@/components/pager'
import { SearchBox } from '@/components/search-box'
import { Timestamp } from '@/components/timestamp'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Toggle } from '@/components/ui/toggle'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { usePageTitle } from '@/hooks/use-page-title'
import {
  pageChange,
  pageSizeChange,
  readChoice,
  readPage,
  readPageSize,
  useLastPageFallback,
  useUrlState,
} from '@/hooks/use-url-state'
import { PLAN_LABEL, STATE_LABEL } from '@/lib/labels'
import { queryKeys } from '@/lib/query'
import { cn } from '@/lib/utils'

const PLANS: readonly LicensePlan[] = ['monthly', 'lifetime']
const STATES: readonly LicenseState[] = ['active', 'expired', 'revoked']
const ALL = 'all'
const COLUMN_COUNT = 8

function LicenseRow({ license, onOpen }: { license: LicenseListItem; onOpen: (id: number) => void }) {
  return (
    <TableRow
      className="cursor-pointer"
      data-license-id={license.id}
      data-license-state={license.state}
      data-license-plan={license.plan}
      data-expires-at={license.expires_at ?? ''}
      data-seats-used={license.seats_used}
      onClick={(event) => {
        // The email is a real link; a click that selected text is not a click on the row.
        const onControl = (event.target as HTMLElement).closest('a, button') !== null
        if (!onControl && window.getSelection()?.toString() === '') {
          onOpen(license.id)
        }
      }}
    >
      <TableCell className="w-full max-w-0">
        <Link to={`/licenses/${license.id}`} className="block truncate font-medium hover:underline">
          {license.email}
        </Link>
      </TableCell>
      <TableCell className="font-mono">
        <span className="text-muted-foreground" aria-hidden="true">
          ····
        </span>
        <span aria-label={`Key ending ${license.key_hint}`}>{license.key_hint}</span>
      </TableCell>
      <TableCell>
        <span className="flex items-center gap-1">
          <PlanBadge plan={license.plan} />
          {license.source === 'manual' && <Badge variant="secondary">Manual</Badge>}
        </span>
      </TableCell>
      <TableCell>
        <StateBadge state={license.state} />
      </TableCell>
      <TableCell>
        {license.expires_at === null ? (
          <span className="text-muted-foreground">Never</span>
        ) : (
          <span className="flex items-center gap-1.5">
            <Timestamp value={license.expires_at} format="date" />
            {license.auto_renew && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <RepeatIcon className="size-3 text-muted-foreground" aria-label="Renews automatically" />
                </TooltipTrigger>
                <TooltipContent>Renews automatically through PayPal</TooltipContent>
              </Tooltip>
            )}
          </span>
        )}
      </TableCell>
      <TableCell className={cn('tabular-nums', license.seats_used === 0 && 'text-muted-foreground')}>
        {license.seats_used} / {license.max_devices}
      </TableCell>
      <TableCell>
        <Timestamp value={license.last_seen_at} format="relative" />
      </TableCell>
      <TableCell>
        <Timestamp value={license.created_at} format="date" />
      </TableCell>
    </TableRow>
  )
}

export function LicensesPage() {
  usePageTitle('Licenses')
  const navigate = useNavigate()
  const [searchParams, updateUrl] = useUrlState()

  const search = searchParams.get('q') ?? ''
  const plan = readChoice(searchParams, 'plan', PLANS)
  const state = readChoice(searchParams, 'state', STATES)
  const expiring = searchParams.get('expiring') === '1'
  const page = readPage(searchParams)
  const pageSize = readPageSize(searchParams)
  const filtered = search.trim() !== '' || plan !== undefined || state !== undefined || expiring

  const params: LicenseListParams = {
    q: search.trim() === '' ? undefined : search.trim(),
    plan,
    state,
    expiring: expiring ? true : undefined,
    page,
    page_size: pageSize,
  }
  const licenses = useQuery({
    queryKey: queryKeys.licenseList(params),
    queryFn: () => listLicenses(params),
    // Keep the rows on screen while the next page or filter loads.
    placeholderData: keepPreviousData,
  })

  useLastPageFallback(licenses.data, page, pageSize, updateUrl)

  // Changing a filter starts again from page 1.
  const setFilter = (changes: Record<string, string | null>, replace = false) =>
    updateUrl({ ...changes, page: null }, { replace })
  const clearFilters = () => setFilter({ q: null, plan: null, state: null, expiring: null })

  const rows = licenses.data?.items ?? []
  // "Nothing matches" is only true for the filters on screen, not for rows kept from the last ones.
  const nothingMatches = licenses.data !== undefined && licenses.data.total === 0 && !licenses.isPlaceholderData
  const waiting = licenses.isPending || (licenses.isPlaceholderData && rows.length === 0)

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <SearchBox
          className="w-80"
          label="Search licenses"
          placeholder="Email, key ending or PayPal id"
          value={search}
          onChange={(value) => setFilter({ q: value }, true)}
        />
        <Select value={plan ?? ALL} onValueChange={(value) => setFilter({ plan: value === ALL ? null : value })}>
          <SelectTrigger aria-label="Plan" className="w-28">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value={ALL}>All plans</SelectItem>
              {PLANS.map((value) => (
                <SelectItem key={value} value={value}>
                  {PLAN_LABEL[value]}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
        <Select value={state ?? ALL} onValueChange={(value) => setFilter({ state: value === ALL ? null : value })}>
          <SelectTrigger aria-label="Status" className="w-32">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value={ALL}>All statuses</SelectItem>
              {STATES.map((value) => (
                <SelectItem key={value} value={value}>
                  {STATE_LABEL[value]}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
        <Toggle
          variant="outline"
          pressed={expiring}
          onPressedChange={(pressed) => setFilter({ expiring: pressed ? '1' : null })}
          data-testid="filter-expiring"
        >
          <ClockIcon data-icon="inline-start" />
          Expiring in {EXPIRING_SOON_DAYS} days
        </Toggle>
        {filtered && (
          <Button variant="ghost" onClick={clearFilters}>
            <FilterXIcon data-icon="inline-start" />
            Clear filters
          </Button>
        )}
        <Button asChild className="ml-auto">
          <Link to="/licenses/new">
            <PlusIcon data-icon="inline-start" />
            New license
          </Link>
        </Button>
      </div>

      {licenses.data === undefined && licenses.isError ? (
        <ErrorState
          title="Could not load licenses"
          error={licenses.error}
          onRetry={() => void licenses.refetch()}
          retrying={licenses.isFetching}
        />
      ) : nothingMatches ? (
        filtered ? (
          <EmptyState
            icon={SearchXIcon}
            title="No licenses match"
            description="Nothing fits this search and these filters. Search looks at the email, the last 4 characters of the key, a complete key, and the PayPal payer or subscription id."
          >
            <Button variant="outline" onClick={clearFilters}>
              <FilterXIcon data-icon="inline-start" />
              Clear filters
            </Button>
          </EmptyState>
        ) : (
          <EmptyState
            icon={KeyRoundIcon}
            title="No licenses yet"
            description="A license appears here when a buyer pays through PayPal, or when you create one by hand."
          >
            <Button asChild>
              <Link to="/licenses/new">
                <PlusIcon data-icon="inline-start" />
                New license
              </Link>
            </Button>
          </EmptyState>
        )
      ) : (
        <>
          {licenses.isError && (
            <RefreshFailedNotice
              error={licenses.error}
              onRetry={() => void licenses.refetch()}
              retrying={licenses.isFetching}
            />
          )}
          <div className="overflow-hidden rounded-lg border" aria-busy={licenses.isFetching}>
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Email</TableHead>
                  <TableHead>Key</TableHead>
                  <TableHead>Plan</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Expires</TableHead>
                  <TableHead>Seats</TableHead>
                  <TableHead>Last seen</TableHead>
                  <TableHead>Created</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody className={cn('transition-opacity', licenses.isPlaceholderData && 'opacity-50')}>
                {waiting ? (
                  <SkeletonRows columns={COLUMN_COUNT} rows={14} />
                ) : (
                  rows.map((license) => (
                    <LicenseRow key={license.id} license={license} onOpen={(id) => void navigate(`/licenses/${id}`)} />
                  ))
                )}
              </TableBody>
            </Table>
          </div>
          {licenses.data !== undefined && (
            <Pager
              page={page}
              pageSize={pageSize}
              total={licenses.data.total}
              noun={['license', 'licenses']}
              onPageChange={(next) => updateUrl(pageChange(next))}
              onPageSizeChange={(next) => updateUrl(pageSizeChange(next))}
            />
          )}
        </>
      )}
    </>
  )
}
