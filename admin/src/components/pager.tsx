import { useId } from 'react'
import { ChevronLeftIcon, ChevronRightIcon, ChevronsLeftIcon, ChevronsRightIcon } from 'lucide-react'

import { PAGE_SIZES } from '@/api'
import { formatCount } from '@/lib/format'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

interface PagerProps {
  /** 1-based. */
  page: number
  pageSize: number
  /** Rows that match the filters, across all pages. */
  total: number
  /** What a row is called: ['license', 'licenses']. */
  noun: [one: string, many: string]
  onPageChange: (page: number) => void
  /** Omit to hide the rows-per-page choice. */
  onPageSizeChange?: (pageSize: number) => void
}

/** "51–100 of 342 licenses", rows per page, and first / previous / next / last. */
export function Pager({ page, pageSize, total, noun, onPageChange, onPageSizeChange }: PagerProps) {
  const sizeLabelId = useId()
  const pageCount = Math.max(1, Math.ceil(total / pageSize))
  const first = total === 0 ? 0 : (page - 1) * pageSize + 1
  const last = Math.min(total, page * pageSize)

  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 text-xs text-muted-foreground">
      <p className="tabular-nums" data-testid="pager-range">
        {total === 0
          ? `0 ${noun[1]}`
          : `${formatCount(first)}–${formatCount(last)} of ${formatCount(total)} ${total === 1 ? noun[0] : noun[1]}`}
      </p>
      <div className="flex items-center gap-3">
        {onPageSizeChange !== undefined && (
          <div className="flex items-center gap-2">
            <span id={sizeLabelId}>Rows per page</span>
            <Select value={String(pageSize)} onValueChange={(value) => onPageSizeChange(Number(value))}>
              <SelectTrigger size="sm" aria-labelledby={sizeLabelId}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {PAGE_SIZES.map((size) => (
                    <SelectItem key={size} value={String(size)}>
                      {size}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </div>
        )}
        <p className="tabular-nums" data-testid="pager-page">
          Page {formatCount(Math.min(page, pageCount))} of {formatCount(pageCount)}
        </p>
        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="icon-sm"
            aria-label="First page"
            disabled={page <= 1}
            onClick={() => onPageChange(1)}
          >
            <ChevronsLeftIcon />
          </Button>
          <Button
            variant="outline"
            size="icon-sm"
            aria-label="Previous page"
            disabled={page <= 1}
            onClick={() => onPageChange(page - 1)}
          >
            <ChevronLeftIcon />
          </Button>
          <Button
            variant="outline"
            size="icon-sm"
            aria-label="Next page"
            disabled={page >= pageCount}
            onClick={() => onPageChange(page + 1)}
          >
            <ChevronRightIcon />
          </Button>
          <Button
            variant="outline"
            size="icon-sm"
            aria-label="Last page"
            disabled={page >= pageCount}
            onClick={() => onPageChange(pageCount)}
          >
            <ChevronsRightIcon />
          </Button>
        </div>
      </div>
    </div>
  )
}
