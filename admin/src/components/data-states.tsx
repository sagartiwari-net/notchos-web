import type { ComponentType, ReactNode } from 'react'
import { RefreshCwIcon, TriangleAlertIcon } from 'lucide-react'

import { errorMessage } from '@/api'
import { cn } from '@/lib/utils'
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { TableCell, TableRow } from '@/components/ui/table'

interface ErrorStateProps {
  /** What could not be done, for example "Could not load licenses". */
  title: string
  error: unknown
  onRetry?: () => void
  retrying?: boolean
  className?: string
}

/** The error state of a page or a panel: what failed, the server's message, and Retry. */
export function ErrorState({ title, error, onRetry, retrying = false, className }: ErrorStateProps) {
  return (
    <Alert variant="destructive" className={className}>
      <TriangleAlertIcon />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>{errorMessage(error)}</AlertDescription>
      {onRetry !== undefined && (
        <AlertAction>
          <Button variant="outline" size="sm" onClick={onRetry} disabled={retrying}>
            {retrying ? <Spinner data-icon="inline-start" /> : <RefreshCwIcon data-icon="inline-start" />}
            Retry
          </Button>
        </AlertAction>
      )}
    </Alert>
  )
}

interface RefreshFailedNoticeProps {
  error: unknown
  onRetry: () => void
  retrying?: boolean
}

/**
 * For a page that already shows data when a refresh in the background fails: the data
 * stays on screen (it may be out of date) and this line says so.
 */
export function RefreshFailedNotice({ error, onRetry, retrying = false }: RefreshFailedNoticeProps) {
  return (
    <Alert>
      <TriangleAlertIcon />
      <AlertTitle>Could not refresh</AlertTitle>
      <AlertDescription>What you see was loaded earlier and may be out of date. {errorMessage(error)}</AlertDescription>
      <AlertAction>
        <Button variant="outline" size="sm" onClick={onRetry} disabled={retrying}>
          {retrying ? <Spinner data-icon="inline-start" /> : <RefreshCwIcon data-icon="inline-start" />}
          Retry
        </Button>
      </AlertAction>
    </Alert>
  )
}

interface EmptyStateProps {
  icon: ComponentType
  title: string
  description?: ReactNode
  /** Buttons or links offered as the next step. */
  children?: ReactNode
  className?: string
}

/** The empty state of a list: nothing to show, why, and what to do next. */
export function EmptyState({ icon: Icon, title, description, children, className }: EmptyStateProps) {
  return (
    <Empty className={cn('flex-none border py-14', className)}>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Icon />
        </EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        {description !== undefined && <EmptyDescription>{description}</EmptyDescription>}
      </EmptyHeader>
      {children !== undefined && <EmptyContent>{children}</EmptyContent>}
    </Empty>
  )
}

// Shares of the column, not fixed widths, so the placeholders never make the table wider.
const SKELETON_WIDTHS = ['w-3/5', 'w-4/5', 'w-2/5', 'w-3/4', 'w-1/2', 'w-2/3', 'w-3/5', 'w-1/2', 'w-4/5']

/** Placeholder rows while a table loads for the first time. */
export function SkeletonRows({ columns, rows = 12 }: { columns: number; rows?: number }) {
  return Array.from({ length: rows }, (_, row) => (
    <TableRow key={row} className="hover:bg-transparent">
      {Array.from({ length: columns }, (_, column) => (
        <TableCell key={column}>
          <Skeleton className={cn('h-4', SKELETON_WIDTHS[(row + column) % SKELETON_WIDTHS.length])} />
        </TableCell>
      ))}
    </TableRow>
  ))
}

/** Centered spinner for the moments before the app knows whether anyone is signed in. */
export function FullPageSpinner({ label }: { label: string }) {
  return (
    <div className="flex min-h-svh items-center justify-center gap-2 text-xs text-muted-foreground">
      <Spinner />
      {label}
    </div>
  )
}
