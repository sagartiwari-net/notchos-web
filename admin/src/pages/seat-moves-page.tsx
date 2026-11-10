import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { ArrowRightLeftIcon } from 'lucide-react'
import { Link } from 'react-router'

import { listSeatMoves, type SeatMove } from '@/api'
import { EmptyState, ErrorState, RefreshFailedNotice, SkeletonRows } from '@/components/data-states'
import { Pager } from '@/components/pager'
import { SearchBox } from '@/components/search-box'
import { Timestamp } from '@/components/timestamp'
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

const COLUMN_COUNT = 7

const REASON_LABEL: Record<SeatMove['reason'], string> = {
  user_deactivate: 'Deactivated',
  user_transfer: 'Transferred',
  admin_free_seat: 'Admin freed',
  admin_revoke: 'Revoked',
}

function MoveRow({ move }: { move: SeatMove }) {
  return (
    <TableRow>
      <TableCell>
        <Timestamp value={move.created_at} />
      </TableCell>
      <TableCell className="max-w-[10rem] truncate">{move.email}</TableCell>
      <TableCell className="font-mono">···{move.key_hint}</TableCell>
      <TableCell>
        <Link to={`/licenses/${move.license_id}`} className="font-medium hover:underline">
          #{move.license_id}
        </Link>
      </TableCell>
      <TableCell>{REASON_LABEL[move.reason]}</TableCell>
      <TableCell className="font-mono text-muted-foreground">
        {move.from_device_name ?? (move.from_device_id ? shortId(move.from_device_id, 10) : '–')}
        {move.to_device_id || move.to_device_name ? (
          <>
            {' → '}
            {move.to_device_name ?? shortId(move.to_device_id!, 10)}
          </>
        ) : null}
      </TableCell>
      <TableCell className="tabular-nums text-muted-foreground">{move.transfers_left_after} left</TableCell>
    </TableRow>
  )
}

export function SeatMovesPage() {
  usePageTitle('Seat moves')
  const [searchParams, updateUrl] = useUrlState()
  const page = readPage(searchParams)
  const pageSize = readPageSize(searchParams)
  const q = searchParams.get('q') ?? ''

  const params = { q: q || undefined, page, page_size: pageSize }
  const list = useQuery({
    queryKey: queryKeys.seatMoveList(params),
    queryFn: () => listSeatMoves(params),
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
          <h1 className="text-lg font-semibold">Seat moves</h1>
          <p className="text-sm text-muted-foreground">
            Unlink and transfer history for support — email, key hint, from → to Mac.
          </p>
        </div>
        <SearchBox
          label="Search seat moves"
          value={q}
          onChange={(value) => updateUrl({ q: value.trim() === '' ? null : value.trim(), page: null })}
          placeholder="Email, key hint, device, license id"
        />
      </div>

      {list.isError && list.data === undefined ? (
        <ErrorState
          title="Could not load seat moves"
          error={list.error}
          onRetry={() => void list.refetch()}
          retrying={list.isFetching}
        />
      ) : nothingToShow ? (
        <EmptyState
          icon={ArrowRightLeftIcon}
          title={q ? 'No moves match that search' : 'No seat moves yet'}
          description="Deactivate this Mac and Move license actions show up here."
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
                <TableHead>When</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>Key</TableHead>
                <TableHead>License</TableHead>
                <TableHead>Reason</TableHead>
                <TableHead>From → to</TableHead>
                <TableHead>Transfers</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((move) => (
                <MoveRow key={move.id} move={move} />
              ))}
            </TableBody>
          </Table>
          {list.data !== undefined && (
            <Pager
              page={list.data.page}
              pageSize={list.data.page_size}
              total={list.data.total}
              noun={['move', 'moves']}
              onPageChange={(next) => updateUrl(pageChange(next))}
              onPageSizeChange={(size) => updateUrl(pageSizeChange(size))}
            />
          )}
        </>
      )}
    </>
  )
}
