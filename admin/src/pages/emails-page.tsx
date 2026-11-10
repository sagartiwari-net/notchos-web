import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { MailIcon } from 'lucide-react'

import { listEmails, type EmailLogItem } from '@/api'
import { EmptyState, ErrorState, RefreshFailedNotice, SkeletonRows } from '@/components/data-states'
import { Pager } from '@/components/pager'
import { SearchBox } from '@/components/search-box'
import { Timestamp } from '@/components/timestamp'
import { Badge } from '@/components/ui/badge'
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
import { queryKeys } from '@/lib/query'

const COLUMN_COUNT = 6

function statusVariant(status: string): 'default' | 'secondary' | 'destructive' | 'outline' {
  if (status === 'failed') return 'destructive'
  if (status === 'sent') return 'default'
  return 'secondary'
}

function EmailRow({ row }: { row: EmailLogItem }) {
  return (
    <TableRow>
      <TableCell className="max-w-[16rem] truncate font-medium">{row.to_email}</TableCell>
      <TableCell className="font-mono text-muted-foreground">{row.template}</TableCell>
      <TableCell>
        <Badge variant={statusVariant(row.status)}>{row.status}</Badge>
      </TableCell>
      <TableCell className="tabular-nums">{row.attempts}</TableCell>
      <TableCell className="max-w-[18rem] truncate text-muted-foreground" title={row.error ?? undefined}>
        {row.error ?? '–'}
      </TableCell>
      <TableCell>
        <Timestamp value={row.created_at} />
      </TableCell>
    </TableRow>
  )
}

export function EmailsPage() {
  usePageTitle('Emails')
  const [searchParams, updateUrl] = useUrlState()
  const page = readPage(searchParams)
  const pageSize = readPageSize(searchParams)
  const q = searchParams.get('q') ?? ''
  const status = searchParams.get('status') ?? ''

  const params = { q: q || undefined, status: status || undefined, page, page_size: pageSize }
  const list = useQuery({
    queryKey: queryKeys.emailList(params),
    queryFn: () => listEmails(params),
    placeholderData: keepPreviousData,
  })
  useLastPageFallback(list.data, page, pageSize, updateUrl)

  const rows = list.data?.items ?? []
  const nothingToShow = list.data !== undefined && list.data.total === 0 && !list.isPlaceholderData
  const waiting = list.isPending || (list.isPlaceholderData && rows.length === 0)

  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold">Emails</h1>
          <p className="text-sm text-muted-foreground">
            Outbound mail log. SMTP is configured under Settings.
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <label className="grid gap-1 text-sm">
            <span className="text-muted-foreground">Status</span>
            <select
              className="h-9 rounded-md border bg-background px-2 text-sm"
              value={status}
              onChange={(event) =>
                updateUrl({ status: event.target.value === '' ? null : event.target.value, page: null })
              }
            >
              <option value="">All</option>
              <option value="sent">sent</option>
              <option value="file">file</option>
              <option value="failed">failed</option>
            </select>
          </label>
          <SearchBox
            label="Search emails"
            value={q}
            onChange={(value) => updateUrl({ q: value.trim() === '' ? null : value.trim(), page: null })}
            placeholder="Search email or template"
          />
        </div>
      </div>

      {list.isError && list.data === undefined ? (
        <ErrorState
          title="Could not load emails"
          error={list.error}
          onRetry={() => void list.refetch()}
          retrying={list.isFetching}
        />
      ) : nothingToShow ? (
        <EmptyState
          icon={MailIcon}
          title={q || status ? 'No emails match that filter' : 'No emails yet'}
          description="Trial download and license key mail will show up here after they are sent."
        />
      ) : waiting ? (
        <SkeletonRows columns={COLUMN_COUNT} />
      ) : (
        <>
          {list.isError && (
            <RefreshFailedNotice error={list.error} onRetry={() => void list.refetch()} retrying={list.isFetching} />
          )}
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>To</TableHead>
                <TableHead>Template</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Attempts</TableHead>
                <TableHead>Error</TableHead>
                <TableHead>Sent</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <EmailRow key={row.id} row={row} />
              ))}
            </TableBody>
          </Table>
          {list.data !== undefined && (
            <Pager
              page={list.data.page}
              pageSize={list.data.page_size}
              total={list.data.total}
              noun={['email', 'emails']}
              onPageChange={(next) => updateUrl(pageChange(next))}
              onPageSizeChange={(size) => updateUrl(pageSizeChange(size))}
            />
          )}
        </>
      )}
    </>
  )
}
