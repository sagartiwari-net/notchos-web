import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { ScrollTextIcon, XIcon } from 'lucide-react'
import { Link } from 'react-router'

import { AUDIT_ACTIONS, listAuditLog, type AuditLogEntry, type AuditLogParams } from '@/api'
import { EmptyState, ErrorState, RefreshFailedNotice, SkeletonRows } from '@/components/data-states'
import { Pager } from '@/components/pager'
import { Timestamp } from '@/components/timestamp'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { usePageTitle } from '@/hooks/use-page-title'
import {
  pageChange,
  pageSizeChange,
  readPage,
  readPageSize,
  useLastPageFallback,
  useUrlState,
} from '@/hooks/use-url-state'
import { actionLabel, licenseIdOfTarget } from '@/lib/labels'
import { queryKeys } from '@/lib/query'
import { cn } from '@/lib/utils'

const ALL = 'all'
const COLUMN_COUNT = 6

/** What the action was done to, as a link where there is a page for it. */
function Target({ target }: { target: string | null }) {
  if (target === null) {
    return <span className="text-muted-foreground">–</span>
  }
  const licenseId = licenseIdOfTarget(target)
  if (licenseId !== null) {
    return (
      <Button variant="link" size="sm" asChild className="h-auto px-0">
        <Link to={`/licenses/${licenseId}`}>License #{licenseId}</Link>
      </Button>
    )
  }
  if (target === 'settings') {
    return (
      <Button variant="link" size="sm" asChild className="h-auto px-0">
        <Link to="/settings">Settings</Link>
      </Button>
    )
  }
  if (target === 'session') {
    return <span className="text-muted-foreground">Session</span>
  }
  return <span>{target}</span>
}

function describeTarget(target: string): string {
  const licenseId = licenseIdOfTarget(target)
  return licenseId === null ? target : `License #${licenseId}`
}

function AuditRow({ entry }: { entry: AuditLogEntry }) {
  return (
    <TableRow data-audit-action={entry.action} data-audit-target={entry.target ?? ''}>
      <TableCell>
        <Timestamp value={entry.created_at} />
      </TableCell>
      <TableCell>
        {entry.admin_username ?? <span className="text-muted-foreground">Deleted admin</span>}
      </TableCell>
      <TableCell title={entry.action}>{actionLabel(entry.action)}</TableCell>
      <TableCell>
        <Target target={entry.target} />
      </TableCell>
      <TableCell className="w-full max-w-0 truncate" title={entry.detail ?? undefined}>
        {entry.detail ?? <span className="text-muted-foreground">–</span>}
      </TableCell>
      <TableCell className="font-mono text-muted-foreground">{entry.ip ?? '–'}</TableCell>
    </TableRow>
  )
}

export function AuditLogPage() {
  usePageTitle('Audit log')
  const [searchParams, updateUrl] = useUrlState()

  const action = searchParams.get('action') ?? undefined
  const target = searchParams.get('target') ?? undefined
  const page = readPage(searchParams)
  const pageSize = readPageSize(searchParams)
  const filtered = action !== undefined || target !== undefined

  const params: AuditLogParams = { action, target, page, page_size: pageSize }
  const log = useQuery({
    queryKey: queryKeys.auditLog(params),
    queryFn: () => listAuditLog(params),
    placeholderData: keepPreviousData,
  })
  useLastPageFallback(log.data, page, pageSize, updateUrl)

  const rows = log.data?.items ?? []
  const nothingToShow = log.data !== undefined && log.data.total === 0 && !log.isPlaceholderData
  const waiting = log.isPending || (log.isPlaceholderData && rows.length === 0)
  // An action from a link that this build has no name for still has to be selectable.
  const actions = action !== undefined && !AUDIT_ACTIONS.some((known) => known === action) ? [...AUDIT_ACTIONS, action] : AUDIT_ACTIONS

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={action ?? ALL}
          onValueChange={(value) => updateUrl({ action: value === ALL ? null : value, page: null })}
        >
          <SelectTrigger aria-label="Action" className="w-48">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value={ALL}>All actions</SelectItem>
              {actions.map((name) => (
                <SelectItem key={name} value={name}>
                  {actionLabel(name)}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
        {target !== undefined && (
          <Badge variant="secondary" data-testid="audit-target-filter">
            Only {describeTarget(target)}
            <button
              type="button"
              className="-mr-1 rounded-full p-0.5 hover:bg-foreground/10"
              aria-label={`Stop filtering by ${describeTarget(target)}`}
              onClick={() => updateUrl({ target: null, page: null })}
            >
              <XIcon className="size-2.5" />
            </button>
          </Badge>
        )}
        <p className="text-xs text-muted-foreground">Every sign-in and every change made in this panel, newest first.</p>
      </div>

      {log.data === undefined && log.isError ? (
        <ErrorState
          title="Could not load the audit log"
          error={log.error}
          onRetry={() => void log.refetch()}
          retrying={log.isFetching}
        />
      ) : nothingToShow ? (
        <EmptyState
          icon={ScrollTextIcon}
          title={filtered ? 'No entries match' : 'Nothing has been logged yet'}
          description={
            filtered
              ? 'No admin action fits this filter.'
              : 'Every sign-in and every change made in this panel is written here.'
          }
        >
          {filtered && (
            <Button variant="outline" onClick={() => updateUrl({ action: null, target: null, page: null })}>
              Show everything
            </Button>
          )}
        </EmptyState>
      ) : (
        <>
          {log.isError && (
            <RefreshFailedNotice error={log.error} onRetry={() => void log.refetch()} retrying={log.isFetching} />
          )}
          <div className="overflow-hidden rounded-lg border" aria-busy={log.isFetching}>
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>When</TableHead>
                  <TableHead>Admin</TableHead>
                  <TableHead>Action</TableHead>
                  <TableHead>Target</TableHead>
                  <TableHead>Detail</TableHead>
                  <TableHead>IP</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody className={cn('transition-opacity', log.isPlaceholderData && 'opacity-50')}>
                {waiting ? (
                  <SkeletonRows columns={COLUMN_COUNT} rows={14} />
                ) : (
                  rows.map((entry) => <AuditRow key={entry.id} entry={entry} />)
                )}
              </TableBody>
            </Table>
          </div>
          {log.data !== undefined && (
            <Pager
              page={page}
              pageSize={pageSize}
              total={log.data.total}
              noun={['entry', 'entries']}
              onPageChange={(next) => updateUrl(pageChange(next))}
              onPageSizeChange={(next) => updateUrl(pageSizeChange(next))}
            />
          )}
        </>
      )}
    </>
  )
}
