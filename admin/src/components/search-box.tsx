import { useEffect, useEffectEvent, useRef, useState } from 'react'
import { SearchIcon, XIcon } from 'lucide-react'

import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from '@/components/ui/input-group'

interface SearchBoxProps {
  /** The search text the page is using now (it lives in the URL). */
  value: string
  /** Called a moment after the admin stops typing, and at once when the box is cleared. */
  onChange: (value: string) => void
  placeholder: string
  label: string
  className?: string
}

const PAUSE_MS = 300

/** A search field that reports what was typed after a short pause, not on every key. */
export function SearchBox({ value, onChange, placeholder, label, className }: SearchBoxProps) {
  const [text, setText] = useState(value)
  // The last value this box reported. Lets it tell its own updates from outside ones.
  const reported = useRef(value)

  const report = useEffectEvent((next: string) => {
    reported.current = next
    onChange(next)
  })

  // The value changed from outside (Back button, Clear filters): show it.
  useEffect(() => {
    if (value !== reported.current) {
      reported.current = value
      setText(value)
    }
  }, [value])

  // The admin typed: report it after a pause.
  useEffect(() => {
    if (text === reported.current) {
      return
    }
    const timer = window.setTimeout(() => report(text), PAUSE_MS)
    return () => window.clearTimeout(timer)
  }, [text])

  return (
    <InputGroup className={className}>
      <InputGroupAddon>
        <SearchIcon />
      </InputGroupAddon>
      <InputGroupInput
        type="text"
        role="searchbox"
        aria-label={label}
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
        value={text}
        onChange={(event) => setText(event.target.value)}
      />
      {text !== '' && (
        <InputGroupAddon align="inline-end">
          <InputGroupButton
            size="icon-xs"
            aria-label="Clear search"
            onClick={() => {
              setText('')
              reported.current = ''
              onChange('')
            }}
          >
            <XIcon />
          </InputGroupButton>
        </InputGroupAddon>
      )}
    </InputGroup>
  )
}
