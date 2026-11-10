import { createContext, useContext, type ReactNode } from 'react'

export interface ConfirmOptions {
  title: string
  /** What will happen, in plain words. */
  description: ReactNode
  /** The verb on the confirm button, for example "Revoke license". */
  confirmLabel: string
  cancelLabel?: string
  /** Styles the confirm button as destructive. */
  destructive?: boolean
}

export type Confirm = (options: ConfirmOptions) => Promise<boolean>

export const ConfirmContext = createContext<Confirm | null>(null)

/**
 * Asks the admin to confirm before something that is hard to take back:
 *
 *   const confirm = useConfirm()
 *   if (await confirm({ title, description, confirmLabel, destructive: true })) { ... }
 *
 * Resolves false on Cancel, on Escape, and when another confirm replaces it.
 * The dialog itself is rendered once by <ConfirmProvider> (components/confirm.tsx).
 */
export function useConfirm(): Confirm {
  const confirm = useContext(ConfirmContext)
  if (confirm === null) {
    throw new Error('useConfirm must be used inside <ConfirmProvider>.')
  }
  return confirm
}
