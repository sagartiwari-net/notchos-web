import { useEffect, useRef, useState, type ComponentProps } from 'react'
import { CheckIcon, CopyIcon } from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'

interface CopyButtonProps extends Omit<ComponentProps<typeof Button>, 'onClick' | 'children'> {
  /** The text that goes to the clipboard. */
  value: string
  /** Button text. Without it the button is icon-only and needs `aria-label`. */
  label?: string
}

/** Copies a value to the clipboard and shows a check mark for a moment. */
export function CopyButton({ value, label, variant = 'outline', size, ...props }: CopyButtonProps) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<number | undefined>(undefined)

  useEffect(() => () => window.clearTimeout(timer.current), [])

  async function copy() {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      window.clearTimeout(timer.current)
      timer.current = window.setTimeout(() => setCopied(false), 1600)
    } catch {
      toast.error('Could not copy. Select the text and copy it by hand.')
    }
  }

  const Icon = copied ? CheckIcon : CopyIcon
  if (label === undefined) {
    return (
      <Button type="button" variant={variant} size={size ?? 'icon-sm'} onClick={copy} {...props}>
        <Icon />
      </Button>
    )
  }
  return (
    <Button type="button" variant={variant} size={size} onClick={copy} {...props}>
      <Icon data-icon="inline-start" />
      {copied ? 'Copied' : label}
    </Button>
  )
}
