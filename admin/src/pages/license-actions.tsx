/**
 * The license actions that need input: extend, change plan, allow more Macs, change email,
 * edit the note. Each is a small form in one shared dialog. Change plan and change email go
 * through the confirm dialog before anything is sent.
 */

import { useState, type FormEvent, type ReactNode } from 'react'
import { useMutation } from '@tanstack/react-query'
import { TriangleAlertIcon } from 'lucide-react'
import { toast } from 'sonner'

import {
  changeLicenseEmail,
  changeLicensePlan,
  errorMessage,
  extendLicense,
  isApiError,
  setLicenseMaxDevices,
  setLicenseNote,
  type LicenseDetail,
  type LicensePlan,
} from '@/api'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { Textarea } from '@/components/ui/textarea'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { useConfirm } from '@/hooks/use-confirm'
import { addDaysIso, formatDate, formatDateTime } from '@/lib/format'
import { PLAN_LABEL, plural } from '@/lib/labels'
import { invalidateAfterLicenseChange, queryClient, queryKeys } from '@/lib/query'
import { daysProblem, devicesProblem, isEmail, NOTE_MAX_LENGTH, wholeNumber } from '@/lib/validation'

export type LicenseDialogKind = 'extend' | 'plan' | 'devices' | 'email' | 'note'

const DAY_PRESETS = ['7', '30', '90', '365']

/** The server's message for one input, if the last attempt was refused because of it. */
function serverFieldError(error: unknown, field: string): string | undefined {
  return isApiError(error) ? error.fields[field] : undefined
}

/** Saves a change that answers with the updated license, and refreshes what depends on it. */
function useLicenseChange<TInput>(licenseId: number, send: (input: TInput) => Promise<LicenseDetail>) {
  return useMutation({
    mutationFn: send,
    onSuccess: (detail) => {
      queryClient.setQueryData(queryKeys.license(licenseId), detail)
      invalidateAfterLicenseChange()
    },
  })
}

interface FormFrameProps {
  title: string
  description: ReactNode
  submitLabel: string
  pending: boolean
  /** False while the form has nothing valid to send. */
  canSubmit: boolean
  /** The failed attempt, unless one of `fieldNames` already shows its message. */
  error: unknown
  fieldNames: string[]
  onSubmit: () => void
  children: ReactNode
}

function FormFrame({
  title,
  description,
  submitLabel,
  pending,
  canSubmit,
  error,
  fieldNames,
  onSubmit,
  children,
}: FormFrameProps) {
  const shownOnField = fieldNames.some((name) => serverFieldError(error, name) !== undefined)

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (canSubmit && !pending) {
      onSubmit()
    }
  }

  return (
    <form onSubmit={submit} noValidate className="grid gap-4">
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>{description}</DialogDescription>
      </DialogHeader>
      <FieldGroup>{children}</FieldGroup>
      {error !== null && error !== undefined && !shownOnField && (
        <Alert variant="destructive">
          <TriangleAlertIcon />
          <AlertTitle>Could not save</AlertTitle>
          <AlertDescription>{errorMessage(error)}</AlertDescription>
        </Alert>
      )}
      <DialogFooter>
        <DialogClose asChild>
          <Button type="button" variant="outline" disabled={pending}>
            Cancel
          </Button>
        </DialogClose>
        <Button type="submit" disabled={!canSubmit || pending}>
          {pending && <Spinner data-icon="inline-start" />}
          {submitLabel}
        </Button>
      </DialogFooter>
    </form>
  )
}

/** "Before" and "after" of a date, so the admin sees exactly what will be stored. */
function DatePreview({ rows }: { rows: Array<{ label: string; value: string }> }) {
  return (
    <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-1 rounded-md border bg-muted/40 px-3 py-2">
      {rows.map((row) => (
        <div key={row.label} className="contents">
          <dt className="text-muted-foreground">{row.label}</dt>
          <dd className="tabular-nums">{row.value}</dd>
        </div>
      ))}
    </dl>
  )
}

interface DaysFieldProps {
  id: string
  label: string
  value: string
  onChange: (value: string) => void
  error: string | undefined
}

function DaysField({ id, label, value, onChange, error }: DaysFieldProps) {
  return (
    <Field data-invalid={error !== undefined}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <div className="flex items-center gap-2">
        <Input
          id={id}
          inputMode="numeric"
          autoComplete="off"
          className="w-20"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          aria-invalid={error !== undefined}
        />
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          aria-label="Common lengths"
          value={DAY_PRESETS.includes(value.trim()) ? value.trim() : ''}
          onValueChange={(next) => {
            if (next !== '') {
              onChange(next)
            }
          }}
        >
          {DAY_PRESETS.map((days) => (
            <ToggleGroupItem key={days} value={days}>
              {days} d
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>
      {error !== undefined && <FieldError>{error}</FieldError>}
    </Field>
  )
}

interface FormProps {
  detail: LicenseDetail
  onDone: () => void
}

// ---------------------------------------------------------------------------
// Extend
// ---------------------------------------------------------------------------

function ExtendForm({ detail, onDone }: FormProps) {
  const { license } = detail
  const [days, setDays] = useState('30')
  // Fixed while the dialog is open, so the date in the preview is the date that is sent.
  const [now] = useState(() => Date.now())
  const change = useLicenseChange(license.id, (periodEnd: string) => extendLicense(license.id, { period_end: periodEnd }))

  const currentEnd = license.period_end === null ? null : Date.parse(license.period_end)
  const lapsed = currentEnd === null || currentEnd <= now
  const count = wholeNumber(days)
  const problem = daysProblem(count)
  const nextEnd = problem === undefined && count !== null ? addDaysIso(lapsed ? now : currentEnd, count) : null

  return (
    <FormFrame
      title="Extend license"
      description={
        lapsed
          ? 'The paid period has ended, so the days count from now.'
          : 'The days are added to the end of the current paid period.'
      }
      submitLabel="Extend"
      pending={change.isPending}
      canSubmit={nextEnd !== null}
      error={change.error}
      fieldNames={['period_end']}
      onSubmit={() => {
        if (nextEnd === null) {
          return
        }
        change.mutate(nextEnd, {
          onSuccess: (updated) => {
            toast.success(`Extended. Paid through ${formatDate(updated.license.period_end ?? nextEnd)}.`)
            onDone()
          },
        })
      }}
    >
      <DaysField
        id="extend-days"
        label="Days to add"
        value={days}
        onChange={(value) => {
          setDays(value)
          change.reset()
        }}
        error={problem ?? serverFieldError(change.error, 'period_end')}
      />
      <DatePreview
        rows={[
          { label: 'Paid through now', value: license.period_end === null ? 'not set' : formatDateTime(license.period_end) },
          { label: 'After extending', value: nextEnd === null ? '–' : formatDateTime(nextEnd) },
        ]}
      />
      {license.auto_renew && (
        <FieldDescription>
          Auto-renew is on, so the app enforces this date plus the renewal buffer from Settings.
        </FieldDescription>
      )}
    </FormFrame>
  )
}

// ---------------------------------------------------------------------------
// Change plan
// ---------------------------------------------------------------------------

function ChangePlanForm({ detail, onDone }: FormProps) {
  const { license } = detail
  const confirm = useConfirm()
  const target: LicensePlan = license.plan === 'monthly' ? 'lifetime' : 'monthly'
  const [days, setDays] = useState('30')
  const [now] = useState(() => Date.now())
  const change = useLicenseChange(license.id, (periodEnd: string | null) =>
    changeLicensePlan(license.id, periodEnd === null ? { plan: 'lifetime' } : { plan: 'monthly', period_end: periodEnd }),
  )

  const count = wholeNumber(days)
  const problem = target === 'monthly' ? daysProblem(count) : undefined
  const periodEnd = target === 'monthly' && problem === undefined && count !== null ? addDaysIso(now, count) : null
  const subscribed = license.paypal_subscription_id !== null && license.auto_renew

  async function submit() {
    const confirmed = await confirm({
      title: `Change plan to ${PLAN_LABEL[target].toLowerCase()}?`,
      description:
        target === 'lifetime'
          ? `${license.email} gets a license that never expires. Its paid-through date is removed.`
          : `${license.email} gets a license that ends on ${periodEnd === null ? 'the chosen date' : formatDate(periodEnd)}. After that Pro turns off unless the license is extended.`,
      confirmLabel: 'Change plan',
      destructive: true,
    })
    if (!confirmed) {
      return
    }
    change.mutate(periodEnd, {
      onSuccess: () => {
        toast.success(`Plan changed to ${PLAN_LABEL[target].toLowerCase()}.`)
        onDone()
      },
    })
  }

  return (
    <FormFrame
      title={`Change plan to ${PLAN_LABEL[target].toLowerCase()}`}
      description={
        target === 'lifetime'
          ? 'This license is monthly now. As a lifetime license it has no end date and never expires.'
          : 'This license is lifetime now. As a monthly license it gets an end date, and auto-renew stays off.'
      }
      submitLabel="Change plan…"
      pending={change.isPending}
      canSubmit={target === 'lifetime' || periodEnd !== null}
      error={change.error}
      fieldNames={['period_end']}
      onSubmit={() => void submit()}
    >
      {target === 'monthly' && (
        <>
          <DaysField
            id="plan-days"
            label="Valid for, in days from now"
            value={days}
            onChange={(value) => {
              setDays(value)
              change.reset()
            }}
            error={problem ?? serverFieldError(change.error, 'period_end')}
          />
          <DatePreview rows={[{ label: 'Paid through', value: periodEnd === null ? '–' : formatDateTime(periodEnd) }]} />
        </>
      )}
      {subscribed && (
        <Alert>
          <TriangleAlertIcon />
          <AlertTitle>A PayPal subscription is attached</AlertTitle>
          <AlertDescription>
            Subscription {license.paypal_subscription_id} keeps charging the buyer. Changing the plan here does not
            cancel it; cancel it in PayPal.
          </AlertDescription>
        </Alert>
      )}
    </FormFrame>
  )
}

// ---------------------------------------------------------------------------
// Allow more Macs
// ---------------------------------------------------------------------------

function MaxDevicesForm({ detail, onDone }: FormProps) {
  const { license } = detail
  const inUse = detail.activations.filter((activation) => activation.deactivated_at === null).length
  const [value, setValue] = useState(String(license.max_devices))
  const change = useLicenseChange(license.id, (maxDevices: number) =>
    setLicenseMaxDevices(license.id, { max_devices: maxDevices }),
  )

  const count = wholeNumber(value)
  const least = Math.max(1, inUse)
  const problem =
    devicesProblem(count) ??
    (count !== null && count < least
      ? `${inUse} ${plural(inUse, 'Mac holds', 'Macs hold')} a seat. Free a seat first to go lower.`
      : undefined)
  const unchanged = count === license.max_devices

  return (
    <FormFrame
      title="Macs allowed"
      description="How many Macs can hold a seat on this key at the same time. The default is 1."
      submitLabel="Save"
      pending={change.isPending}
      canSubmit={problem === undefined && count !== null && !unchanged}
      error={change.error}
      fieldNames={['max_devices']}
      onSubmit={() => {
        if (count === null) {
          return
        }
        change.mutate(count, {
          onSuccess: (updated) => {
            const allowed = updated.license.max_devices
            toast.success(`This key now allows ${allowed} ${plural(allowed, 'Mac', 'Macs')}.`)
            onDone()
          },
        })
      }}
    >
      <Field data-invalid={problem !== undefined}>
        <FieldLabel htmlFor="max-devices">Macs allowed</FieldLabel>
        {/* The wrapper takes the field's full width, so the input can stay short. */}
        <div>
          <Input
            id="max-devices"
            inputMode="numeric"
            autoComplete="off"
            className="w-20"
            value={value}
            onChange={(event) => {
              setValue(event.target.value)
              change.reset()
            }}
            aria-invalid={problem !== undefined}
          />
        </div>
        {problem !== undefined ? (
          <FieldError>{problem}</FieldError>
        ) : serverFieldError(change.error, 'max_devices') !== undefined ? (
          <FieldError>{serverFieldError(change.error, 'max_devices')}</FieldError>
        ) : (
          <FieldDescription>
            {inUse} of {license.max_devices} {plural(license.max_devices, 'seat is', 'seats are')} in use now.
          </FieldDescription>
        )}
      </Field>
    </FormFrame>
  )
}

// ---------------------------------------------------------------------------
// Change email
// ---------------------------------------------------------------------------

function ChangeEmailForm({ detail, onDone }: FormProps) {
  const { license } = detail
  const confirm = useConfirm()
  const [email, setEmail] = useState(license.email)
  const change = useLicenseChange(license.id, (next: string) => changeLicenseEmail(license.id, { email: next }))

  const trimmed = email.trim()
  const problem = isEmail(trimmed) ? undefined : 'Enter a valid email address.'
  const unchanged = trimmed === license.email
  const serverProblem = serverFieldError(change.error, 'email')

  async function submit() {
    const confirmed = await confirm({
      title: 'Change the email of this license?',
      description: `The key email and every later resend go to ${trimmed} instead of ${license.email}.`,
      confirmLabel: 'Change email',
      destructive: true,
    })
    if (!confirmed) {
      return
    }
    change.mutate(trimmed, {
      onSuccess: () => {
        toast.success(`Email changed to ${trimmed}.`)
        onDone()
      },
    })
  }

  return (
    <FormFrame
      title="Change email"
      description="For a buyer who can no longer read the address on their PayPal account. The key is not sent by this change; use Resend key afterwards."
      submitLabel="Change email…"
      pending={change.isPending}
      canSubmit={problem === undefined && !unchanged}
      error={change.error}
      fieldNames={['email']}
      onSubmit={() => void submit()}
    >
      <Field data-invalid={(problem ?? serverProblem) !== undefined}>
        <FieldLabel htmlFor="license-email">Email</FieldLabel>
        <Input
          id="license-email"
          type="email"
          autoComplete="off"
          spellCheck={false}
          value={email}
          onChange={(event) => {
            setEmail(event.target.value)
            change.reset()
          }}
          aria-invalid={(problem ?? serverProblem) !== undefined}
        />
        {(problem ?? serverProblem) !== undefined ? (
          <FieldError>{problem ?? serverProblem}</FieldError>
        ) : (
          <FieldDescription>Now: {license.email}</FieldDescription>
        )}
      </Field>
    </FormFrame>
  )
}

// ---------------------------------------------------------------------------
// Note
// ---------------------------------------------------------------------------

function NoteForm({ detail, onDone }: FormProps) {
  const { license } = detail
  const [note, setNote] = useState(license.note ?? '')
  const change = useLicenseChange(license.id, (next: string) => setLicenseNote(license.id, { note: next }))

  const unchanged = note.trim() === (license.note ?? '')
  const serverProblem = serverFieldError(change.error, 'note')

  return (
    <FormFrame
      title={license.note === null ? 'Add a note' : 'Edit note'}
      description="For you only. The buyer never sees it. Saving an empty note removes it."
      submitLabel="Save note"
      pending={change.isPending}
      canSubmit={!unchanged}
      error={change.error}
      fieldNames={['note']}
      onSubmit={() =>
        change.mutate(note, {
          onSuccess: (updated) => {
            toast.success(updated.license.note === null ? 'Note removed.' : 'Note saved.')
            onDone()
          },
        })
      }
    >
      <Field data-invalid={serverProblem !== undefined}>
        <FieldLabel htmlFor="license-note">Note</FieldLabel>
        <Textarea
          id="license-note"
          rows={4}
          maxLength={NOTE_MAX_LENGTH}
          value={note}
          onChange={(event) => {
            setNote(event.target.value)
            change.reset()
          }}
          aria-invalid={serverProblem !== undefined}
        />
        {serverProblem !== undefined ? (
          <FieldError>{serverProblem}</FieldError>
        ) : (
          <FieldDescription>
            {note.length} of {NOTE_MAX_LENGTH} characters
          </FieldDescription>
        )}
      </Field>
    </FormFrame>
  )
}

// ---------------------------------------------------------------------------
// The dialog
// ---------------------------------------------------------------------------

interface LicenseActionDialogProps {
  /** Which form to show. Stays set while the dialog closes, so it does not empty mid-animation. */
  kind: LicenseDialogKind
  open: boolean
  onOpenChange: (open: boolean) => void
  detail: LicenseDetail
}

export function LicenseActionDialog({ kind, open, onOpenChange, detail }: LicenseActionDialogProps) {
  const done = () => onOpenChange(false)
  // The form is mounted when the dialog opens, so every opening starts from the current values.
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        {kind === 'extend' && <ExtendForm detail={detail} onDone={done} />}
        {kind === 'plan' && <ChangePlanForm detail={detail} onDone={done} />}
        {kind === 'devices' && <MaxDevicesForm detail={detail} onDone={done} />}
        {kind === 'email' && <ChangeEmailForm detail={detail} onDone={done} />}
        {kind === 'note' && <NoteForm detail={detail} onDone={done} />}
      </DialogContent>
    </Dialog>
  )
}
