import { keepPreviousData, useMutation, useQuery } from '@tanstack/react-query'
import { Share2Icon } from 'lucide-react'
import { Link } from 'react-router'
import { toast } from 'sonner'

import {
  convertSocialSubmissionToMonthly,
  errorMessage,
  listSocialSubmissions,
  reviewSocialSubmission,
  type SocialSubmission,
  type SocialSubmissionStatus,
} from '@/api'
import { EmptyState, ErrorState, RefreshFailedNotice, SkeletonRows } from '@/components/data-states'
import { Pager } from '@/components/pager'
import { SearchBox } from '@/components/search-box'
import { Timestamp } from '@/components/timestamp'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { useConfirm } from '@/hooks/use-confirm'
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
import { invalidateAfterSocialChange, queryKeys } from '@/lib/query'

const COLUMN_COUNT = 8
const ALL = 'all'
const STATUSES: readonly SocialSubmissionStatus[] = [
  'coupon_issued',
  'reviewed_ok',
  'reviewed_bad',
  'converted_monthly',
]

function LinkCell({ href }: { href: string | null }) {
  if (!href) return <span className="text-muted-foreground">–</span>
  return (
    <a href={href} target="_blank" rel="noreferrer" className="text-primary underline-offset-2 hover:underline">
      open
    </a>
  )
}

function StatusBadge({ status }: { status: SocialSubmissionStatus }) {
  const variant =
    status === 'reviewed_ok'
      ? 'success'
      : status === 'reviewed_bad'
        ? 'destructive'
        : status === 'converted_monthly'
          ? 'warning'
          : 'secondary'
  return <Badge variant={variant}>{status.replaceAll('_', ' ')}</Badge>
}

function SubmissionRow({ row }: { row: SocialSubmission }) {
  const confirm = useConfirm()

  const review = useMutation({
    mutationFn: (verdict: 'ok' | 'bad') => reviewSocialSubmission(row.id, { verdict }),
    onSuccess: (updated) => {
      invalidateAfterSocialChange()
      toast.success(updated.status === 'reviewed_ok' ? 'Marked OK' : 'Marked bad')
    },
    onError: (error) => toast.error(errorMessage(error)),
  })

  const convert = useMutation({
    mutationFn: () => convertSocialSubmissionToMonthly(row.id),
    onSuccess: () => {
      invalidateAfterSocialChange()
      toast.success('Converted linked license to Monthly (30 days)')
    },
    onError: (error) => toast.error(errorMessage(error)),
  })

  const busy = review.isPending || convert.isPending

  return (
    <TableRow>
      <TableCell className="max-w-[12rem] truncate font-medium">{row.contact_email}</TableCell>
      <TableCell>
        <StatusBadge status={row.status} />
      </TableCell>
      <TableCell className="font-mono text-xs">{row.coupon_code ?? '–'}</TableCell>
      <TableCell className="tabular-nums">{row.percent_requested}%</TableCell>
      <TableCell>
        <div className="flex flex-wrap gap-2 text-xs">
          <LinkCell href={row.linkedin_url} />
          <LinkCell href={row.facebook_url} />
          <LinkCell href={row.instagram_url} />
          <LinkCell href={row.x_url} />
        </div>
      </TableCell>
      <TableCell className="max-w-[10rem] truncate">
        {row.payer_email ?? <span className="text-muted-foreground">not bought</span>}
      </TableCell>
      <TableCell>
        {row.license_id === null ? (
          <span className="text-muted-foreground">–</span>
        ) : (
          <Button variant="link" size="sm" asChild className="h-auto px-0">
            <Link to={`/licenses/${row.license_id}`}>
              #{row.license_id}
              {row.license_plan ? ` · ${row.license_plan}` : ''}
            </Link>
          </Button>
        )}
      </TableCell>
      <TableCell>
        <div className="flex flex-wrap gap-1">
          <Button
            size="sm"
            variant="outline"
            disabled={busy || row.status === 'converted_monthly'}
            onClick={() => review.mutate('ok')}
          >
            OK
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={busy || row.status === 'converted_monthly'}
            onClick={() => review.mutate('bad')}
          >
            Bad
          </Button>
          <Button
            size="sm"
            variant="secondary"
            disabled={busy || row.status === 'converted_monthly' || row.license_id === null}
            onClick={() => {
              void confirm({
                title: 'Convert to Monthly?',
                description:
                  'Downgrades the Lifetime license that used this coupon to a 30-day Monthly. Use when posts look fake after purchase.',
                confirmLabel: 'Convert to Monthly',
              }).then((ok) => {
                if (ok) convert.mutate()
              })
            }}
          >
            Convert to Monthly
          </Button>
        </div>
        <div className="mt-1 text-muted-foreground">
          <Timestamp value={row.created_at} />
        </div>
      </TableCell>
    </TableRow>
  )
}

export function SocialSubmissionsPage() {
  usePageTitle('Social shares')
  const [searchParams, updateUrl] = useUrlState()
  const page = readPage(searchParams)
  const pageSize = readPageSize(searchParams)
  const q = searchParams.get('q') ?? ''
  const status = readChoice(searchParams, 'status', STATUSES)

  const params = {
    q: q || undefined,
    status,
    page,
    page_size: pageSize,
  }
  const list = useQuery({
    queryKey: queryKeys.socialList(params),
    queryFn: () => listSocialSubmissions(params),
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
          <h1 className="text-lg font-semibold">Social shares</h1>
          <p className="text-sm text-muted-foreground">
            Share links + coupon claims. Review posts; Convert to Monthly if a Lifetime buy used a bad claim.
          </p>
        </div>
        <SearchBox
          label="Search social submissions"
          value={q}
          onChange={(value) => updateUrl({ q: value.trim() === '' ? null : value.trim(), page: null })}
          placeholder="Search email or coupon"
        />
      </div>

      <ToggleGroup
        type="single"
        value={status ?? ALL}
        onValueChange={(value) => {
          if (value !== '') {
            updateUrl({ status: value === ALL ? null : value, page: null })
          }
        }}
        className="justify-start"
      >
        <ToggleGroupItem value={ALL}>All</ToggleGroupItem>
        {STATUSES.map((item) => (
          <ToggleGroupItem key={item} value={item}>
            {item.replaceAll('_', ' ')}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>

      {list.isError && list.data === undefined ? (
        <ErrorState
          title="Could not load social submissions"
          error={list.error}
          onRetry={() => void list.refetch()}
          retrying={list.isFetching}
        />
      ) : nothingToShow ? (
        <EmptyState
          icon={Share2Icon}
          title={q || status ? 'No submissions match' : 'No social submissions yet'}
          description="When someone uses Get discount on the site, they show up here with links and a coupon."
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
                <TableHead>Contact email</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Coupon</TableHead>
                <TableHead>%</TableHead>
                <TableHead>Links</TableHead>
                <TableHead>PayPal email</TableHead>
                <TableHead>License</TableHead>
                <TableHead>Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <SubmissionRow key={row.id} row={row} />
              ))}
            </TableBody>
          </Table>
          {list.data !== undefined && (
            <Pager
              page={list.data.page}
              pageSize={list.data.page_size}
              total={list.data.total}
              noun={['submission', 'submissions']}
              onPageChange={(next) => updateUrl(pageChange(next))}
              onPageSizeChange={(size) => updateUrl(pageSizeChange(size))}
            />
          )}
        </>
      )}
    </>
  )
}
