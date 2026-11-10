import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { MailIcon } from 'lucide-react'

import { listTrialLeads, type TrialLead } from '@/api'
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
import { shortId } from '@/lib/format'
import { queryKeys } from '@/lib/query'

const COLUMN_COUNT = 6

function LeadRow({ lead }: { lead: TrialLead }) {
  return (
    <TableRow>
      <TableCell className="max-w-[14rem] truncate font-medium">{lead.email}</TableCell>
      <TableCell>
        <Badge variant="secondary">{lead.status}</Badge>
      </TableCell>
      <TableCell>
        {lead.download_sent_at ? (
          <Timestamp value={lead.download_sent_at} />
        ) : (
          <span className="text-muted-foreground">–</span>
        )}
      </TableCell>
      <TableCell className="tabular-nums">{lead.resend_count}</TableCell>
      <TableCell className="font-mono text-muted-foreground">
        {lead.converted_trial_device_id ? shortId(lead.converted_trial_device_id, 12) : '–'}
      </TableCell>
      <TableCell>
        <Timestamp value={lead.created_at} />
      </TableCell>
    </TableRow>
  )
}

export function TrialLeadsPage() {
  usePageTitle('Trial leads')
  const [searchParams, updateUrl] = useUrlState()
  const page = readPage(searchParams)
  const pageSize = readPageSize(searchParams)
  const q = searchParams.get('q') ?? ''

  const params = { q: q || undefined, page, page_size: pageSize }
  const list = useQuery({
    queryKey: queryKeys.trialLeadList(params),
    queryFn: () => listTrialLeads(params),
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
          <h1 className="text-lg font-semibold">Trial leads</h1>
          <p className="text-sm text-muted-foreground">
            Emails collected on the site before download. The trial itself still starts in the app.
          </p>
        </div>
        <SearchBox
          label="Search trial leads"
          value={q}
          onChange={(value) => updateUrl({ q: value.trim() === '' ? null : value.trim(), page: null })}
          placeholder="Search email"
        />
      </div>

      {list.isError && list.data === undefined ? (
        <ErrorState
          title="Could not load trial leads"
          error={list.error}
          onRetry={() => void list.refetch()}
          retrying={list.isFetching}
        />
      ) : nothingToShow ? (
        <EmptyState
          icon={MailIcon}
          title={q ? 'No leads match that search' : 'No trial leads yet'}
          description="When someone uses Start free trial on the site, they show up here."
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
                <TableHead>Email</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Download mailed</TableHead>
                <TableHead>Resends</TableHead>
                <TableHead>Trial device</TableHead>
                <TableHead>Created</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((lead) => (
                <LeadRow key={lead.id} lead={lead} />
              ))}
            </TableBody>
          </Table>
          {list.data !== undefined && (
            <Pager
              page={list.data.page}
              pageSize={list.data.page_size}
              total={list.data.total}
              noun={['lead', 'leads']}
              onPageChange={(next) => updateUrl(pageChange(next))}
              onPageSizeChange={(size) => updateUrl(pageSizeChange(size))}
            />
          )}
        </>
      )}
    </>
  )
}
