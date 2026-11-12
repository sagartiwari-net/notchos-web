import { useState, type FormEvent, type ReactNode } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { TriangleAlertIcon } from 'lucide-react'
import { toast } from 'sonner'

import {
  errorMessage,
  getSettings,
  isApiError,
  updateSettings,
  type MailMode,
  type Settings,
  type SettingsUpdate,
} from '@/api'
import { ErrorState, RefreshFailedNotice } from '@/components/data-states'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Field, FieldContent, FieldDescription, FieldError, FieldGroup, FieldLabel, FieldTitle } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupText } from '@/components/ui/input-group'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { usePageTitle } from '@/hooks/use-page-title'
import { queryClient, queryKeys } from '@/lib/query'
import { wholeNumber } from '@/lib/validation'

/** The editable settings as the text that is in the inputs. Keys are the server's input names. */
interface FormValues {
  'prices.monthly': string
  'prices.lifetime': string
  trial_days: string
  transfer_limit: string
  renewal_buffer_hours: string
  download_url: string
  app_version: string
  'mail.mode': MailMode
  'mail.smtp_host': string
  'mail.smtp_port': string
  'mail.smtp_secure': 'true' | 'false'
  'mail.smtp_user': string
  /** Write-only. Empty = keep the stored password (or leave unset). */
  'mail.smtp_pass': string
  'mail.mail_from': string
  'mail.support_email': string
}

type FieldName = keyof FormValues

const TEXT_FIELD_NAMES: FieldName[] = [
  'prices.monthly',
  'prices.lifetime',
  'trial_days',
  'transfer_limit',
  'renewal_buffer_hours',
  'download_url',
  'app_version',
  'mail.smtp_host',
  'mail.smtp_port',
  'mail.smtp_user',
  'mail.mail_from',
  'mail.support_email',
]

/** A setting that is not set yet (null) is an empty input. */
function toForm(settings: Settings): FormValues {
  const mail = settings.mail
  return {
    'prices.monthly': settings.prices.monthly ?? '',
    'prices.lifetime': settings.prices.lifetime ?? '',
    trial_days: String(settings.trial_days),
    transfer_limit: String(settings.transfer_limit),
    renewal_buffer_hours: String(settings.renewal_buffer_hours),
    download_url: settings.download_url ?? '',
    app_version: settings.app_version ?? '',
    'mail.mode': mail.mode,
    'mail.smtp_host': mail.smtp_host,
    'mail.smtp_port': String(mail.smtp_port),
    'mail.smtp_secure': mail.smtp_secure ? 'true' : 'false',
    'mail.smtp_user': mail.smtp_user ?? '',
    'mail.smtp_pass': '',
    'mail.mail_from': mail.mail_from ?? '',
    'mail.support_email': mail.support_email ?? '',
  }
}

/**
 * Only the shape is checked here (is it a number, is it a price). Ranges and everything else
 * are the server's rules; what it refuses comes back per field and is shown the same way.
 * The prices, the download link and the version may stay empty: that means "not set".
 */
function shapeProblems(values: FormValues): Partial<Record<FieldName, string>> {
  const problems: Partial<Record<FieldName, string>> = {}
  const price = /^\d{1,6}(\.\d{1,2})?$/
  const monthly = values['prices.monthly'].trim()
  const lifetime = values['prices.lifetime'].trim()
  if (monthly !== '' && !price.test(monthly)) {
    problems['prices.monthly'] = 'Enter a price such as 4.99, or leave it empty.'
  }
  if (lifetime !== '' && !price.test(lifetime)) {
    problems['prices.lifetime'] = 'Enter a price such as 29.99, or leave it empty.'
  }
  if (wholeNumber(values.trial_days) === null) {
    problems.trial_days = 'Enter a whole number of days.'
  }
  if (wholeNumber(values.transfer_limit) === null) {
    problems.transfer_limit = 'Enter a whole number.'
  }
  if (wholeNumber(values.renewal_buffer_hours) === null) {
    problems.renewal_buffer_hours = 'Enter a whole number of hours. 0 turns the buffer off.'
  }
  if (values['mail.smtp_host'].trim() === '') {
    problems['mail.smtp_host'] = 'Enter an SMTP host, for example smtp.gmail.com.'
  }
  const port = wholeNumber(values['mail.smtp_port'])
  if (port === null || port < 1 || port > 65535) {
    problems['mail.smtp_port'] = 'Enter a port from 1 to 65535 (Gmail uses 465).'
  }
  if (values['mail.mode'] === 'smtp' && values['mail.smtp_user'].trim() === '') {
    problems['mail.smtp_user'] = 'SMTP mode needs a Gmail address.'
  }
  return problems
}

/** An empty input is sent as null: the setting is cleared. */
function textOrNull(text: string): string | null {
  return text.trim() === '' ? null : text.trim()
}

function toUpdate(values: FormValues, passWasSet: boolean): SettingsUpdate {
  const passTyped = values['mail.smtp_pass'].trim()
  const mail: SettingsUpdate['mail'] = {
    mode: values['mail.mode'],
    smtp_host: values['mail.smtp_host'].trim(),
    smtp_port: wholeNumber(values['mail.smtp_port']) ?? 465,
    smtp_secure: values['mail.smtp_secure'] === 'true',
    smtp_user: textOrNull(values['mail.smtp_user']),
    mail_from: textOrNull(values['mail.mail_from']),
    support_email: textOrNull(values['mail.support_email']),
  }
  // Omit smtp_pass to keep the stored one. Only send when the admin typed a new value.
  // If nothing was stored and they leave it blank, the server rejects SMTP mode.
  if (passTyped !== '') {
    mail.smtp_pass = passTyped
  } else if (!passWasSet && values['mail.mode'] === 'smtp') {
    mail.smtp_pass = null
  }
  return {
    prices: { monthly: textOrNull(values['prices.monthly']), lifetime: textOrNull(values['prices.lifetime']) },
    trial_days: wholeNumber(values.trial_days) ?? 0,
    transfer_limit: wholeNumber(values.transfer_limit) ?? 0,
    renewal_buffer_hours: wholeNumber(values.renewal_buffer_hours) ?? 0,
    download_url: textOrNull(values.download_url),
    app_version: textOrNull(values.app_version),
    mail,
  }
}

interface SettingRowProps {
  id: string
  label: string
  description: ReactNode
  error: string | undefined
  children: ReactNode
}

/** One setting: what it is on the left, its input on the right. */
function SettingRow({ id, label, description, error, children }: SettingRowProps) {
  return (
    <Field orientation="horizontal" data-invalid={error !== undefined}>
      <FieldContent>
        <FieldLabel htmlFor={id}>{label}</FieldLabel>
        <FieldDescription>{description}</FieldDescription>
        {error !== undefined && <FieldError>{error}</FieldError>}
      </FieldContent>
      {children}
    </Field>
  )
}

function SettingsForm({ settings }: { settings: Settings }) {
  const [values, setValues] = useState(() => toForm(settings))
  // Field messages appear after the first attempt, not while the admin is still typing.
  const [attempted, setAttempted] = useState(false)

  const save = useMutation({
    mutationFn: updateSettings,
    onSuccess: (saved) => {
      // The form is keyed on the saved values, so it starts again from what the server stored.
      queryClient.setQueryData(queryKeys.settings, saved)
      void queryClient.invalidateQueries({ queryKey: queryKeys.auditLogs })
      toast.success('Settings saved.')
    },
  })

  const saved = toForm(settings)
  const dirty =
    TEXT_FIELD_NAMES.some((name) => values[name].trim() !== saved[name]) ||
    values['mail.mode'] !== saved['mail.mode'] ||
    values['mail.smtp_secure'] !== saved['mail.smtp_secure'] ||
    values['mail.smtp_pass'].trim() !== ''
  const problems = shapeProblems(values)
  const serverFields = isApiError(save.error) ? save.error.fields : {}
  const errorFor = (name: FieldName) => (attempted ? problems[name] : undefined) ?? serverFields[name]
  const allFieldNames: FieldName[] = [
    ...TEXT_FIELD_NAMES,
    'mail.mode',
    'mail.smtp_secure',
    'mail.smtp_pass',
  ]
  const serverErrorOnField = allFieldNames.some((name) => serverFields[name] !== undefined)

  const set = (name: FieldName) => (value: string) => {
    setValues((current) => ({ ...current, [name]: value }))
    if (save.isError) {
      save.reset()
    }
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setAttempted(true)
    if (Object.keys(problems).length > 0) {
      return
    }
    save.mutate(toUpdate(values, settings.mail.smtp_pass_set))
  }

  function discard() {
    setValues(saved)
    setAttempted(false)
    save.reset()
  }

  const smtpMode = values['mail.mode'] === 'smtp'
  const passHint = settings.mail.smtp_pass_set
    ? 'A password is stored. Leave blank to keep it, or type a new Gmail app password.'
    : 'Gmail app password (Google Account → Security → App passwords). Not your normal Gmail password.'

  return (
    <form onSubmit={onSubmit} noValidate className="flex w-full max-w-3xl flex-col gap-4">
      <Card size="sm">
        <CardHeader>
          <CardTitle>
            <h2>Prices</h2>
          </CardTitle>
          <CardDescription>
            What the site shows and what PayPal charges, in USD. A new price applies to purchases made after saving.
            A price can stay empty until it is decided.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <FieldGroup>
            <SettingRow
              id="settings-price-monthly"
              label="Monthly"
              description="Charged every month through a PayPal subscription."
              error={errorFor('prices.monthly')}
            >
              <InputGroup className="w-32 shrink-0">
                <InputGroupInput
                  id="settings-price-monthly"
                  inputMode="decimal"
                  autoComplete="off"
                  placeholder="Not set"
                  value={values['prices.monthly']}
                  onChange={(event) => set('prices.monthly')(event.target.value)}
                  aria-invalid={errorFor('prices.monthly') !== undefined}
                />
                <InputGroupAddon align="inline-end">
                  <InputGroupText>USD</InputGroupText>
                </InputGroupAddon>
              </InputGroup>
            </SettingRow>
            <SettingRow
              id="settings-price-lifetime"
              label="Lifetime"
              description="One PayPal payment, once."
              error={errorFor('prices.lifetime')}
            >
              <InputGroup className="w-32 shrink-0">
                <InputGroupInput
                  id="settings-price-lifetime"
                  inputMode="decimal"
                  autoComplete="off"
                  placeholder="Not set"
                  value={values['prices.lifetime']}
                  onChange={(event) => set('prices.lifetime')(event.target.value)}
                  aria-invalid={errorFor('prices.lifetime') !== undefined}
                />
                <InputGroupAddon align="inline-end">
                  <InputGroupText>USD</InputGroupText>
                </InputGroupAddon>
              </InputGroup>
            </SettingRow>
          </FieldGroup>
        </CardContent>
      </Card>

      <Card size="sm">
        <CardHeader>
          <CardTitle>
            <h2>Trial and licensing</h2>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <FieldGroup>
            <SettingRow
              id="settings-trial-days"
              label="Trial length"
              description="How long the free trial inside the app lasts. Trials that have already started keep their end date."
              error={errorFor('trial_days')}
            >
              <InputGroup className="w-32 shrink-0">
                <InputGroupInput
                  id="settings-trial-days"
                  inputMode="numeric"
                  autoComplete="off"
                  value={values.trial_days}
                  onChange={(event) => set('trial_days')(event.target.value)}
                  aria-invalid={errorFor('trial_days') !== undefined}
                />
                <InputGroupAddon align="inline-end">
                  <InputGroupText>days</InputGroupText>
                </InputGroupAddon>
              </InputGroup>
            </SettingRow>
            <SettingRow
              id="settings-transfer-limit"
              label="Transfer limit"
              description="How many times a buyer can move a key to another Mac on their own."
              error={errorFor('transfer_limit')}
            >
              <InputGroup className="w-32 shrink-0">
                <InputGroupInput
                  id="settings-transfer-limit"
                  inputMode="numeric"
                  autoComplete="off"
                  value={values.transfer_limit}
                  onChange={(event) => set('transfer_limit')(event.target.value)}
                  aria-invalid={errorFor('transfer_limit') !== undefined}
                />
                <InputGroupAddon align="inline-end">
                  <InputGroupText>moves</InputGroupText>
                </InputGroupAddon>
              </InputGroup>
            </SettingRow>
            <SettingRow
              id="settings-renewal-buffer"
              label="Renewal buffer"
              description="How long a renewing monthly license keeps working after its paid period, so a late PayPal charge does not switch Pro off. 0 turns it off."
              error={errorFor('renewal_buffer_hours')}
            >
              <InputGroup className="w-32 shrink-0">
                <InputGroupInput
                  id="settings-renewal-buffer"
                  inputMode="numeric"
                  autoComplete="off"
                  value={values.renewal_buffer_hours}
                  onChange={(event) => set('renewal_buffer_hours')(event.target.value)}
                  aria-invalid={errorFor('renewal_buffer_hours') !== undefined}
                />
                <InputGroupAddon align="inline-end">
                  <InputGroupText>hours</InputGroupText>
                </InputGroupAddon>
              </InputGroup>
            </SettingRow>
          </FieldGroup>
        </CardContent>
      </Card>

      <Card size="sm">
        <CardHeader>
          <CardTitle>
            <h2>App download</h2>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <FieldGroup>
            <SettingRow
              id="settings-download-url"
              label="Download link"
              description="Use the fixed latest URL (https://notch.sagartiwari.net/downloads/NotchOS.dmg) — never a versioned path, so old emails keep working."
              error={errorFor('download_url')}
            >
              <Input
                id="settings-download-url"
                type="url"
                inputMode="url"
                autoComplete="off"
                spellCheck={false}
                placeholder="Not set"
                className="w-96 max-w-full"
                value={values.download_url}
                onChange={(event) => set('download_url')(event.target.value)}
                aria-invalid={errorFor('download_url') !== undefined}
              />
            </SettingRow>
            <SettingRow
              id="settings-app-version"
              label="Current app version"
              description="Displayed version for the current NotchOS.dmg (the download link above stays fixed)."
              error={errorFor('app_version')}
            >
              <Input
                id="settings-app-version"
                autoComplete="off"
                spellCheck={false}
                placeholder="Not set"
                className="w-32 shrink-0"
                value={values.app_version}
                onChange={(event) => set('app_version')(event.target.value)}
                aria-invalid={errorFor('app_version') !== undefined}
              />
            </SettingRow>
          </FieldGroup>
        </CardContent>
      </Card>

      <Card size="sm">
        <CardHeader>
          <CardTitle>
            <h2>Email</h2>
          </CardTitle>
          <CardDescription>
            How NotchOS sends purchase keys, trial mail, and support messages. Use file mode while testing; switch to
            Gmail SMTP when you are ready to send real mail.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <FieldGroup>
            <SettingRow
              id="settings-mail-mode"
              label="Delivery"
              description="File writes HTML into ~/.notchos-dev/mail. SMTP sends through Gmail."
              error={errorFor('mail.mode')}
            >
              <Select
                value={values['mail.mode']}
                onValueChange={(value) => {
                  if (value === 'file' || value === 'smtp') {
                    set('mail.mode')(value)
                  }
                }}
              >
                <SelectTrigger id="settings-mail-mode" className="w-44 shrink-0" aria-invalid={errorFor('mail.mode') !== undefined}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value="file">File (local preview)</SelectItem>
                    <SelectItem value="smtp">SMTP (Gmail)</SelectItem>
                  </SelectGroup>
                </SelectContent>
              </Select>
            </SettingRow>
            <SettingRow
              id="settings-smtp-host"
              label="SMTP host"
              description="Gmail uses smtp.gmail.com."
              error={errorFor('mail.smtp_host')}
            >
              <Input
                id="settings-smtp-host"
                autoComplete="off"
                spellCheck={false}
                className="w-56 shrink-0"
                value={values['mail.smtp_host']}
                onChange={(event) => set('mail.smtp_host')(event.target.value)}
                aria-invalid={errorFor('mail.smtp_host') !== undefined}
                disabled={!smtpMode}
              />
            </SettingRow>
            <SettingRow
              id="settings-smtp-port"
              label="SMTP port"
              description="465 with SSL, or 587 with STARTTLS."
              error={errorFor('mail.smtp_port')}
            >
              <Input
                id="settings-smtp-port"
                inputMode="numeric"
                autoComplete="off"
                className="w-24 shrink-0"
                value={values['mail.smtp_port']}
                onChange={(event) => {
                  const next = event.target.value
                  setValues((current) => {
                    const patch: Partial<FormValues> = { 'mail.smtp_port': next }
                    if (next.trim() === '465') {
                      patch['mail.smtp_secure'] = 'true'
                    } else if (next.trim() === '587') {
                      patch['mail.smtp_secure'] = 'false'
                    }
                    return { ...current, ...patch }
                  })
                  if (save.isError) {
                    save.reset()
                  }
                }}
                aria-invalid={errorFor('mail.smtp_port') !== undefined}
                disabled={!smtpMode}
              />
            </SettingRow>
            <SettingRow
              id="settings-smtp-secure"
              label="TLS"
              description="SSL (port 465) or STARTTLS (port 587)."
              error={errorFor('mail.smtp_secure')}
            >
              <Select
                value={values['mail.smtp_secure']}
                onValueChange={(value) => {
                  if (value === 'true' || value === 'false') {
                    set('mail.smtp_secure')(value)
                  }
                }}
                disabled={!smtpMode}
              >
                <SelectTrigger
                  id="settings-smtp-secure"
                  className="w-44 shrink-0"
                  aria-invalid={errorFor('mail.smtp_secure') !== undefined}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value="true">SSL (secure)</SelectItem>
                    <SelectItem value="false">STARTTLS</SelectItem>
                  </SelectGroup>
                </SelectContent>
              </Select>
            </SettingRow>
            <SettingRow
              id="settings-smtp-user"
              label="SMTP user"
              description="The Gmail address that signs in to SMTP."
              error={errorFor('mail.smtp_user')}
            >
              <Input
                id="settings-smtp-user"
                type="email"
                autoComplete="off"
                spellCheck={false}
                placeholder="you@gmail.com"
                className="w-64 max-w-full"
                value={values['mail.smtp_user']}
                onChange={(event) => set('mail.smtp_user')(event.target.value)}
                aria-invalid={errorFor('mail.smtp_user') !== undefined}
                disabled={!smtpMode}
              />
            </SettingRow>
            <SettingRow
              id="settings-smtp-pass"
              label="App password"
              description={passHint}
              error={errorFor('mail.smtp_pass')}
            >
              <Input
                id="settings-smtp-pass"
                type="password"
                autoComplete="new-password"
                spellCheck={false}
                placeholder={settings.mail.smtp_pass_set ? 'Stored — leave blank to keep' : 'Gmail app password'}
                className="w-64 max-w-full"
                value={values['mail.smtp_pass']}
                onChange={(event) => set('mail.smtp_pass')(event.target.value)}
                aria-invalid={errorFor('mail.smtp_pass') !== undefined}
                disabled={!smtpMode}
              />
            </SettingRow>
            <SettingRow
              id="settings-mail-from"
              label="From"
              description='Header shown to buyers, for example NotchOS &lt;you@gmail.com&gt;. Empty uses the SMTP user.'
              error={errorFor('mail.mail_from')}
            >
              <Input
                id="settings-mail-from"
                autoComplete="off"
                spellCheck={false}
                placeholder="NotchOS <you@gmail.com>"
                className="w-72 max-w-full"
                value={values['mail.mail_from']}
                onChange={(event) => set('mail.mail_from')(event.target.value)}
                aria-invalid={errorFor('mail.mail_from') !== undefined}
              />
            </SettingRow>
            <SettingRow
              id="settings-support-email"
              label="Support email"
              description="Shown in email footers. Empty uses support@notchos.app."
              error={errorFor('mail.support_email')}
            >
              <Input
                id="settings-support-email"
                type="email"
                autoComplete="off"
                spellCheck={false}
                placeholder="support@notchos.app"
                className="w-64 max-w-full"
                value={values['mail.support_email']}
                onChange={(event) => set('mail.support_email')(event.target.value)}
                aria-invalid={errorFor('mail.support_email') !== undefined}
              />
            </SettingRow>
          </FieldGroup>
        </CardContent>
      </Card>

      <Card size="sm">
        <CardHeader>
          <CardTitle>
            <h2>PayPal</h2>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <FieldGroup>
            <Field orientation="horizontal">
              <FieldContent>
                <FieldTitle>Monthly plan id</FieldTitle>
                <FieldDescription>
                  Written by the PayPal setup script in phase W3. It cannot be changed here.
                </FieldDescription>
              </FieldContent>
              {settings.paypal_plan_id === null ? (
                <span className="text-muted-foreground" data-testid="paypal-plan-id">
                  Not set yet
                </span>
              ) : (
                <code className="font-mono" data-testid="paypal-plan-id">
                  {settings.paypal_plan_id}
                </code>
              )}
            </Field>
          </FieldGroup>
        </CardContent>
      </Card>

      {save.isError && !serverErrorOnField && (
        <Alert variant="destructive">
          <TriangleAlertIcon />
          <AlertTitle>Could not save the settings</AlertTitle>
          <AlertDescription>{errorMessage(save.error)}</AlertDescription>
        </Alert>
      )}

      <div className="flex items-center gap-2">
        <Button type="submit" disabled={!dirty || save.isPending}>
          {save.isPending && <Spinner data-icon="inline-start" />}
          Save changes
        </Button>
        <Button type="button" variant="ghost" disabled={!dirty || save.isPending} onClick={discard}>
          Discard
        </Button>
        <span className="text-xs text-muted-foreground" role="status" data-testid="settings-status">
          {dirty ? 'You have unsaved changes.' : 'Everything is saved.'}
        </span>
      </div>
    </form>
  )
}

function SettingsSkeleton() {
  return (
    <div className="flex w-full max-w-3xl flex-col gap-4" aria-busy="true" aria-label="Loading the settings">
      <Skeleton className="h-36" />
      <Skeleton className="h-48" />
      <Skeleton className="h-36" />
      <Skeleton className="h-64" />
    </div>
  )
}

export function SettingsPage() {
  usePageTitle('Settings')
  const settings = useQuery({ queryKey: queryKeys.settings, queryFn: getSettings })

  if (settings.data === undefined) {
    if (settings.isError) {
      return (
        <ErrorState
          title="Could not load the settings"
          error={settings.error}
          onRetry={() => void settings.refetch()}
          retrying={settings.isFetching}
        />
      )
    }
    return <SettingsSkeleton />
  }
  return (
    <>
      {settings.isError && (
        <RefreshFailedNotice
          error={settings.error}
          onRetry={() => void settings.refetch()}
          retrying={settings.isFetching}
        />
      )}
      {/* Keyed on the stored values: after a save (or a change made elsewhere) the form starts
          again from what the server has. A refetch that brings the same values leaves it alone,
          whatever else the answer carries (server_time changes every time). */}
      <SettingsForm
        key={JSON.stringify([toForm(settings.data), settings.data.paypal_plan_id, settings.data.mail.smtp_pass_set])}
        settings={settings.data}
      />
    </>
  )
}
