import { cn } from '@/lib/utils'

/** The product mark: a screen outline with the notch at its top edge. Same drawing as the favicon. */
export function NotchMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true" className={cn('size-5', className)}>
      <rect x="4.75" y="7.75" width="22.5" height="16.5" rx="3.25" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M11 7.5h10v2.25A2.25 2.25 0 0 1 18.75 12h-5.5A2.25 2.25 0 0 1 11 9.75z" fill="currentColor" />
    </svg>
  )
}
