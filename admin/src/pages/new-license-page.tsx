import { useState, type FormEvent } from 'react'
import { useMutation } from '@tanstack/react-query'
import { TriangleAlertIcon } from 'lucide-react'
import { Link, useNavigate } from 'react-router'
import { toast } from 'sonner'

import { createLicense, errorMessage, isApiError, type CreateLicenseInput, type LicensePlan } from '@/api'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel, FieldTitle } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { Textarea } from '@/components/ui/textarea'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { usePageTitle } from '@/hooks/use-page-title'
import { rememberCreatedKey } from '@/lib/created-keys'
import { addDaysIso, daysFromNowIso, formatDate } from '@/lib/format'
import { invalidateAfterLicenseChange } from '@/lib/query'
import { daysProblem, devicesProblem, isEmail, NOTE_MAX_LENGTH, wholeNumber } from '@/lib/validation'

const DAY_PRESETS = ['30', '90', '365']

export function NewLicensePage() {
  usePageTitle('New license')
  const navigate = useNavigate()

  const [email, setEmail] = useState('')
  const [plan, setPlan] = useState<LicensePlan>('lifetime')
  const [days, setDays] = useState('30')
  const [maxDevices, setMaxDevices] = useState('1')
  const [note, setNote] = useState('')
  // Field messages appear after the first attempt, not while the admin is still typing.
  const [attempted, setAttempted] = useState(false)

  const create = useMutation({
    mutationFn: createLicense,
    // The answer holds the new key: it is handed to the detail page and not kept in the cache.
    gcTime: 0,
    onSuccess: ({ license, key }) => {
      // The detail page shows the new key once; it never goes through the URL.
      rememberCreatedKey(license.id, key)
      invalidateAfterLicenseChange()
      toast.success('License created.')
      void navigate(`/licenses/${license.id}`)
    },
  })

  const dayCount = wholeNumber(days)
  const deviceCount = wholeNumber(maxDevices)
  const problems = {
    email: isEmail(email) ? undefined : 'Enter a valid email address.',
    period_end: plan === 'monthly' ? daysProblem(dayCount) : undefined,
    max_devices: devicesProblem(deviceCount),
  }
  const serverFields = isApiError(create.error) ? create.error.fields : {}
  // What each field shows: its own check after an attempt, else what the server said last time.
  const shown = {
    email: (attempted ? problems.email : undefined) ?? serverFields.email,
    period_end: (attempted ? problems.period_end : undefined) ?? serverFields.period_end,
    max_devices: (attempted ? problems.max_devices : undefined) ?? serverFields.max_devices,
    note: serverFields.note,
  }
  const serverErrorOnField = ['email', 'period_end', 'max_devices', 'note'].some(
    (name) => serverFields[name] !== undefined,
  )

  // Only for the preview; the request gets a fresh value at the moment of sending.
  const [previewNow] = useState(() => Date.now())
  const previewEnd = plan === 'monthly' && problems.period_end === undefined && dayCount !== null ? addDaysIso(previewNow, dayCount) : null

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setAttempted(true)
    if (
      problems.email !== undefined ||
      problems.period_end !== undefined ||
      problems.max_devices !== undefined ||
      deviceCount === null
    ) {
      return
    }
    const input: CreateLicenseInput = {
      email: email.trim(),
      plan,
      max_devices: deviceCount,
    }
    if (plan === 'monthly' && dayCount !== null) {
      input.period_end = daysFromNowIso(dayCount)
    }
    if (note.trim() !== '') {
      input.note = note.trim()
    }
    create.mutate(input)
  }

  const edited = () => {
    if (create.isError) {
      create.reset()
    }
  }

  return (
    <form onSubmit={onSubmit} noValidate className="w-full max-w-xl">
      <Card>
        <CardHeader>
          <CardTitle>
            <h2>Manual license</h2>
          </CardTitle>
          <CardDescription>
            A key you hand out yourself: for your team, as a gift, or to help a buyer. It is not tied to a PayPal
            payment. The key is shown once on the next screen.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <FieldGroup>
            <Field data-invalid={shown.email !== undefined}>
              <FieldLabel htmlFor="new-email">Email</FieldLabel>
              <Input
                id="new-email"
                name="email"
                type="email"
                autoComplete="off"
                spellCheck={false}
                autoFocus
                placeholder="name@example.com"
                value={email}
                onChange={(event) => {
                  setEmail(event.target.value)
                  edited()
                }}
                aria-invalid={shown.email !== undefined}
              />
              {shown.email !== undefined ? (
                <FieldError>{shown.email}</FieldError>
              ) : (
                <FieldDescription>Who the key belongs to. Resend key sends it to this address.</FieldDescription>
              )}
            </Field>

            <Field>
              <FieldTitle id="new-plan-label">Plan</FieldTitle>
              <ToggleGroup
                type="single"
                variant="outline"
                aria-labelledby="new-plan-label"
                value={plan}
                onValueChange={(next) => {
                  if (next === 'lifetime' || next === 'monthly') {
                    setPlan(next)
                    edited()
                  }
                }}
              >
                <ToggleGroupItem value="lifetime">Lifetime</ToggleGroupItem>
                <ToggleGroupItem value="monthly">Monthly</ToggleGroupItem>
              </ToggleGroup>
              <FieldDescription>
                {plan === 'lifetime'
                  ? 'Never expires.'
                  : 'Ends on a date. It does not renew by itself; extend it from the license page.'}
              </FieldDescription>
            </Field>

            {plan === 'monthly' && (
              <Field data-invalid={shown.period_end !== undefined}>
                <FieldLabel htmlFor="new-days">Valid for, in days from now</FieldLabel>
                <div className="flex items-center gap-2">
                  <Input
                    id="new-days"
                    name="days"
                    inputMode="numeric"
                    autoComplete="off"
                    className="w-20"
                    value={days}
                    onChange={(event) => {
                      setDays(event.target.value)
                      edited()
                    }}
                    aria-invalid={shown.period_end !== undefined}
                  />
                  <ToggleGroup
                    type="single"
                    variant="outline"
                    size="sm"
                    aria-label="Common lengths"
                    value={DAY_PRESETS.includes(days.trim()) ? days.trim() : ''}
                    onValueChange={(next) => {
                      if (next !== '') {
                        setDays(next)
                        edited()
                      }
                    }}
                  >
                    {DAY_PRESETS.map((preset) => (
                      <ToggleGroupItem key={preset} value={preset}>
                        {preset} d
                      </ToggleGroupItem>
                    ))}
                  </ToggleGroup>
                </div>
                {shown.period_end !== undefined ? (
                  <FieldError>{shown.period_end}</FieldError>
                ) : (
                  <FieldDescription>
                    {previewEnd === null
                      ? 'Sets the end date.'
                      : `Ends on ${formatDate(previewEnd)}, counted from the moment you create it.`}
                  </FieldDescription>
                )}
              </Field>
            )}

            <Field data-invalid={shown.max_devices !== undefined}>
              <FieldLabel htmlFor="new-max-devices">Macs allowed</FieldLabel>
              {/* The wrapper takes the field's full width, so the input can stay short. */}
              <div>
                <Input
                  id="new-max-devices"
                  name="max_devices"
                  inputMode="numeric"
                  autoComplete="off"
                  className="w-20"
                  value={maxDevices}
                  onChange={(event) => {
                    setMaxDevices(event.target.value)
                    edited()
                  }}
                  aria-invalid={shown.max_devices !== undefined}
                />
              </div>
              {shown.max_devices !== undefined ? (
                <FieldError>{shown.max_devices}</FieldError>
              ) : (
                <FieldDescription>How many Macs can use this key at the same time. Normally 1.</FieldDescription>
              )}
            </Field>

            <Field data-invalid={shown.note !== undefined}>
              <FieldLabel htmlFor="new-note">Note (optional)</FieldLabel>
              <Textarea
                id="new-note"
                name="note"
                rows={3}
                maxLength={NOTE_MAX_LENGTH}
                placeholder="Why this key exists, for example: gift for a beta tester"
                value={note}
                onChange={(event) => {
                  setNote(event.target.value)
                  edited()
                }}
                aria-invalid={shown.note !== undefined}
              />
              {shown.note !== undefined && <FieldError>{shown.note}</FieldError>}
            </Field>

            {create.isError && !serverErrorOnField && (
              <Alert variant="destructive">
                <TriangleAlertIcon />
                <AlertTitle>Could not create the license</AlertTitle>
                <AlertDescription>{errorMessage(create.error)}</AlertDescription>
              </Alert>
            )}
          </FieldGroup>
        </CardContent>
        <CardFooter className="gap-2">
          <Button type="submit" disabled={create.isPending}>
            {create.isPending && <Spinner data-icon="inline-start" />}
            Create license
          </Button>
          <Button type="button" variant="ghost" asChild>
            <Link to="/licenses">Cancel</Link>
          </Button>
        </CardFooter>
      </Card>
    </form>
  )
}
