import { useState, type FormEvent } from 'react'
import { keepPreviousData, useMutation, useQuery } from '@tanstack/react-query'
import { HourglassIcon, PlayIcon, TriangleAlertIcon } from 'lucide-react'
import { Link } from 'react-router'
import { toast } from 'sonner'

import {
  createTrial,
  errorMessage,
  isApiError,
  listTrials,
  type CreateTrialInput,
  type TrialListItem,
  type TrialListParams,
  type TrialState,
} from '@/api'
import { TrialStateBadge } from '@/components/badges'
import { EmptyState, ErrorState, RefreshFailedNotice, SkeletonRows } from '@/components/data-states'
import { Pager } from '@/components/pager'
import { Timestamp } from '@/components/timestamp'
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
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { usePageTitle } from '@/hooks/use-page-title'
import {
  pageChange,
  pageSizeChange,
  readChoice,
  readPage,
  readPageSize,
  useLastPageFallback,
  useUrlState,
} from '@/hooks/use-url-state'
import { formatDateTime, shortId } from '@/lib/format'
import { invalidateAfterTrialChange, queryKeys } from '@/lib/query'
import { cn } from '@/lib/utils'
import { APP_VERSION_MAX, deviceIdProblem, wholeNumber } from '@/lib/validation'

const STATES: readonly TrialState[] = ['active', 'ended']
const ALL = 'all'
const COLUMN_COUNT = 8
const TRIAL_DAYS_MIN = 1
const TRIAL_DAYS_MAX = 365

function TrialRow({ trial }: { trial: TrialListItem }) {
  return (
    <TableRow data-trial-state={trial.state}>
      <TableCell>
        <Tooltip>
          <TooltipTrigger asChild>
            <code className="font-mono">{shortId(trial.device_id, 16)}</code>
          </TooltipTrigger>
          <TooltipContent className="max-w-80 font-mono break-all">{trial.device_id}</TooltipContent>
        </Tooltip>
      </TableCell>
      <TableCell className="max-w-[12rem] truncate">
        {trial.email ?? <span className="text-muted-foreground">–</span>}
      </TableCell>
      <TableCell>
        <Timestamp value={trial.started_at} />
      </TableCell>
      <TableCell>
        <Timestamp value={trial.expires_at} relative />
      </TableCell>
      <TableCell>
        <TrialStateBadge state={trial.state} />
      </TableCell>
      <TableCell className="tabular-nums">
        {trial.app_version ?? <span className="text-muted-foreground">–</span>}
      </TableCell>
      <TableCell className="font-mono text-muted-foreground">{trial.ip ?? '–'}</TableCell>
      <TableCell>
        {trial.converted_license_id === null ? (
          <span className="text-muted-foreground">–</span>
        ) : (
          <Button variant="link" size="sm" asChild className="h-auto px-0">
            <Link to={`/licenses/${trial.converted_license_id}`}>License #{trial.converted_license_id}</Link>
          </Button>
        )}
      </TableCell>
    </TableRow>
  )
}

function StartTrialDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [deviceId, setDeviceId] = useState('')
  const [days, setDays] = useState('7')
  const [reset, setReset] = useState(false)
  const [appVersion, setAppVersion] = useState('')
  const [attempted, setAttempted] = useState(false)

  const create = useMutation({
    mutationFn: createTrial,
    onSuccess: (trial, input) => {
      invalidateAfterTrialChange()
      toast.success(input.reset ? 'Trial reset' : 'Trial started', {
        description: `Expires ${formatDateTime(trial.expires_at)}.`,
      })
      onOpenChange(false)
      setDeviceId('')
      setDays('7')
      setReset(false)
      setAppVersion('')
      setAttempted(false)
    },
  })

  const dayCount = wholeNumber(days)
  const deviceProblem = deviceIdProblem(deviceId)
  const daysProblemText =
    dayCount === null || dayCount < TRIAL_DAYS_MIN || dayCount > TRIAL_DAYS_MAX
      ? `Enter a whole number of days from ${TRIAL_DAYS_MIN} to ${TRIAL_DAYS_MAX}.`
      : undefined
  const versionProblem =
    appVersion.trim().length > APP_VERSION_MAX ? `Enter up to ${APP_VERSION_MAX} characters.` : undefined
  const serverFields = isApiError(create.error) ? create.error.fields : {}
  const shown = {
    device_id: (attempted ? deviceProblem : undefined) ?? serverFields.device_id,
    days: (attempted ? daysProblemText : undefined) ?? serverFields.days,
    app_version: (attempted ? versionProblem : undefined) ?? serverFields.app_version,
  }
  const shownOnField =
    shown.device_id !== undefined || shown.days !== undefined || shown.app_version !== undefined

  function edited() {
    if (create.isError) {
      create.reset()
    }
  }

  function clearForm() {
    setDeviceId('')
    setDays('7')
    setReset(false)
    setAppVersion('')
    setAttempted(false)
    create.reset()
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setAttempted(true)
    if (
      deviceProblem !== undefined ||
      daysProblemText !== undefined ||
      versionProblem !== undefined ||
      dayCount === null
    ) {
      return
    }
    const input: CreateTrialInput = {
      device_id: deviceId.trim(),
      days: dayCount,
      reset: reset || undefined,
    }
    if (appVersion.trim() !== '') {
      input.app_version = appVersion.trim()
    }
    create.mutate(input)
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!create.isPending) {
          onOpenChange(next)
          if (!next) {
            clearForm()
          }
        }
      }}
    >
      <DialogContent>
        <form onSubmit={onSubmit} noValidate className="grid gap-4">
          <DialogHeader>
            <DialogTitle>Start trial</DialogTitle>
            <DialogDescription>
              Grant a free trial to a Mac by its device id. Production trials normally start inside the
              NotchOS app; use this for support or testing.
            </DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <Field data-invalid={shown.device_id !== undefined}>
              <FieldLabel htmlFor="start-trial-device-id">Device id</FieldLabel>
              <Input
                id="start-trial-device-id"
                name="device_id"
                autoComplete="off"
                spellCheck={false}
                autoFocus
                className="font-mono"
                placeholder="16+ characters, A–Z a–z 0–9 _ -"
                value={deviceId}
                onChange={(event) => {
                  setDeviceId(event.target.value)
                  edited()
                }}
                aria-invalid={shown.device_id !== undefined}
              />
              {shown.device_id !== undefined ? (
                <FieldError>{shown.device_id}</FieldError>
              ) : (
                <FieldDescription>Same id the Mac app sends on activate and trial.</FieldDescription>
              )}
            </Field>
            <Field data-invalid={shown.days !== undefined}>
              <FieldLabel htmlFor="start-trial-days">Days</FieldLabel>
              <Input
                id="start-trial-days"
                name="days"
                inputMode="numeric"
                value={days}
                onChange={(event) => {
                  setDays(event.target.value)
                  edited()
                }}
                aria-invalid={shown.days !== undefined}
              />
              {shown.days !== undefined ? (
                <FieldError>{shown.days}</FieldError>
              ) : (
                <FieldDescription>How long the new or reset trial runs. Usually 7.</FieldDescription>
              )}
            </Field>
            <Field orientation="horizontal">
              <input
                id="start-trial-reset"
                name="reset"
                type="checkbox"
                checked={reset}
                onChange={(event) => {
                  setReset(event.target.checked)
                  edited()
                }}
                className="size-4 rounded border border-input accent-primary"
              />
              <div className="grid gap-1">
                <FieldLabel htmlFor="start-trial-reset" className="font-normal">
                  Reset if this Mac already used its trial
                </FieldLabel>
                <FieldDescription>Starts a fresh period when the previous trial has ended.</FieldDescription>
              </div>
            </Field>
            <Field data-invalid={shown.app_version !== undefined}>
              <FieldLabel htmlFor="start-trial-app-version">App version</FieldLabel>
              <Input
                id="start-trial-app-version"
                name="app_version"
                autoComplete="off"
                spellCheck={false}
                placeholder="Optional, for example 0.7.0"
                value={appVersion}
                onChange={(event) => {
                  setAppVersion(event.target.value)
                  edited()
                }}
                aria-invalid={shown.app_version !== undefined}
              />
              {shown.app_version !== undefined ? (
                <FieldError>{shown.app_version}</FieldError>
              ) : (
                <FieldDescription>Optional. Stored with the trial when you start a new one.</FieldDescription>
              )}
            </Field>
          </FieldGroup>
          {create.isError && !shownOnField && (
            <Alert variant="destructive">
              <TriangleAlertIcon />
              <AlertTitle>Could not start trial</AlertTitle>
              <AlertDescription>{errorMessage(create.error)}</AlertDescription>
            </Alert>
          )}
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline" disabled={create.isPending}>
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={create.isPending}>
              {create.isPending && <Spinner data-icon="inline-start" />}
              Start trial
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export function TrialsPage() {
  usePageTitle('Trials')
  const [searchParams, updateUrl] = useUrlState()
  const [startOpen, setStartOpen] = useState(false)

  const state = readChoice(searchParams, 'state', STATES)
  const page = readPage(searchParams)
  const pageSize = readPageSize(searchParams)

  const params: TrialListParams = { state, page, page_size: pageSize }
  const trials = useQuery({
    queryKey: queryKeys.trialList(params),
    queryFn: () => listTrials(params),
    placeholderData: keepPreviousData,
  })

  useLastPageFallback(trials.data, page, pageSize, updateUrl)

  const rows = trials.data?.items ?? []
  const nothingToShow = trials.data !== undefined && trials.data.total === 0 && !trials.isPlaceholderData
  const waiting = trials.isPending || (trials.isPlaceholderData && rows.length === 0)

  return (
    <>
      <div className="flex flex-wrap items-center gap-3">
        <ToggleGroup
          type="single"
          variant="outline"
          aria-label="Which trials to show"
          value={state ?? ALL}
          onValueChange={(next) => {
            if (next !== '') {
              updateUrl({ state: next === ALL ? null : next, page: null })
            }
          }}
        >
          <ToggleGroupItem value={ALL}>All</ToggleGroupItem>
          <ToggleGroupItem value="active">On trial</ToggleGroupItem>
          <ToggleGroupItem value="ended">Ended</ToggleGroupItem>
        </ToggleGroup>
        <p className="min-w-0 flex-1 text-xs text-muted-foreground">
          A trial normally starts inside the app, without a key or an email. Use Start trial for support or
          testing; each Mac still gets one end date unless you reset it.
        </p>
        <Button className="ml-auto" onClick={() => setStartOpen(true)}>
          <PlayIcon data-icon="inline-start" />
          Start trial
        </Button>
      </div>

      <StartTrialDialog open={startOpen} onOpenChange={setStartOpen} />

      {trials.data === undefined && trials.isError ? (
        <ErrorState
          title="Could not load trials"
          error={trials.error}
          onRetry={() => void trials.refetch()}
          retrying={trials.isFetching}
        />
      ) : nothingToShow ? (
        <EmptyState
          icon={HourglassIcon}
          title={state === undefined ? 'No trials yet' : state === 'active' ? 'No Mac is on trial now' : 'No trial has ended yet'}
          description="A row appears here when someone starts the free trial inside the app, or when you start one here."
        >
          {state !== undefined ? (
            <Button variant="outline" onClick={() => updateUrl({ state: null, page: null })}>
              Show all trials
            </Button>
          ) : (
            <Button onClick={() => setStartOpen(true)}>
              <PlayIcon data-icon="inline-start" />
              Start trial
            </Button>
          )}
        </EmptyState>
      ) : (
        <>
          {trials.isError && (
            <RefreshFailedNotice error={trials.error} onRetry={() => void trials.refetch()} retrying={trials.isFetching} />
          )}
          <div className="overflow-hidden rounded-lg border" aria-busy={trials.isFetching}>
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Device id</TableHead>
                  <TableHead>Email</TableHead>
                  <TableHead>Started</TableHead>
                  <TableHead>Ends</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>App</TableHead>
                  <TableHead>IP</TableHead>
                  <TableHead>Bought</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody className={cn('transition-opacity', trials.isPlaceholderData && 'opacity-50')}>
                {waiting ? (
                  <SkeletonRows columns={COLUMN_COUNT} rows={14} />
                ) : (
                  rows.map((trial) => <TrialRow key={trial.device_id} trial={trial} />)
                )}
              </TableBody>
            </Table>
          </div>
          {trials.data !== undefined && (
            <Pager
              page={page}
              pageSize={pageSize}
              total={trials.data.total}
              noun={['trial', 'trials']}
              onPageChange={(next) => updateUrl(pageChange(next))}
              onPageSizeChange={(next) => updateUrl(pageSizeChange(next))}
            />
          )}
        </>
      )}
    </>
  )
}
