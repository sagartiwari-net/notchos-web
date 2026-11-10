import { cn } from '@/lib/utils'
import { formatDate, formatDateTime, formatRelative, formatUtc } from '@/lib/format'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

interface TimestampProps {
  /** ISO 8601 UTC string from the API, or null. */
  value: string | null
  /**
   * 'datetime'  local date and time (default)
   * 'date'      local date
   * 'relative'  "2 hours ago"; the local date and time move into the hover text
   */
  format?: 'datetime' | 'date' | 'relative'
  /** With 'datetime' or 'date': adds "in 3 days" or "2 days ago" after it. */
  relative?: boolean
  /** Shown instead when the value is null. */
  empty?: string
  className?: string
}

/**
 * Times are stored in UTC. The admin shows them in the browser's local time; hovering shows
 * the stored UTC value.
 */
export function Timestamp({ value, format = 'datetime', relative = false, empty = '–', className }: TimestampProps) {
  if (value === null) {
    return <span className={cn('text-muted-foreground', className)}>{empty}</span>
  }
  const text =
    format === 'relative' ? formatRelative(value) : format === 'date' ? formatDate(value) : formatDateTime(value)
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <time dateTime={value} className={cn('tabular-nums', className)}>
          {text}
          {relative && format !== 'relative' && (
            <span className="text-muted-foreground"> · {formatRelative(value)}</span>
          )}
        </time>
      </TooltipTrigger>
      <TooltipContent className="flex-col items-start gap-0.5 tabular-nums">
        {format !== 'datetime' && <span>{formatDateTime(value)} local</span>}
        <span>{formatUtc(value)}</span>
      </TooltipContent>
    </Tooltip>
  )
}
