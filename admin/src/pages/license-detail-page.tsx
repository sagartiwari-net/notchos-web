import { useEffect, useState, type ReactNode } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import {
  ArrowLeftRightIcon,
  AtSignIcon,
  BanIcon,
  CalendarPlusIcon,
  CircleCheckIcon,
  EyeIcon,
  EyeOffIcon,
  FileQuestionIcon,
  LaptopIcon,
  NotebookPenIcon,
  RotateCcwIcon,
  SendIcon,
} from 'lucide-react'
import { Link, useParams } from 'react-router'
import { toast } from 'sonner'

import {
  dataSource,
  errorMessage,
  freeSeat,
  getLicense,
  isNotFound,
  resendLicenseKey,
  restoreLicense,
  revealLicenseKey,
  revokeLicense,
  type Activation,
  type LicenseDetail,
  type LicenseEvent,
  type LicenseEventType,
} from '@/api'
import { PlanBadge, StateBadge } from '@/components/badges'
import { CopyButton } from '@/components/copy-button'
import { EmptyState, ErrorState, RefreshFailedNotice } from '@/components/data-states'
import { Pager } from '@/components/pager'
import { Timestamp } from '@/components/timestamp'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useConfirm } from '@/hooks/use-confirm'
import { usePageTitle } from '@/hooks/use-page-title'
import { forgetCreatedKey, peekCreatedKey } from '@/lib/created-keys'
import { formatCount, formatDateTime, formatRelative, formatUtc, maskedKey, shortId } from '@/lib/format'
import { eventLabel, PLAN_LABEL, plural, SOURCE_LABEL, UNNAMED_MAC } from '@/lib/labels'
import { invalidateAfterLicenseChange, queryClient, queryKeys } from '@/lib/query'
import { LicenseActionDialog, type LicenseDialogKind } from '@/pages/license-actions'

const EVENTS_PER_PAGE = 15

// ---------------------------------------------------------------------------
// Small pieces
// ---------------------------------------------------------------------------

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="contents">
      <dt className="py-0.5 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 py-0.5">{children}</dd>
    </div>
  )
}

function Facts({ children }: { children: ReactNode }) {
  return <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-6 gap-y-1">{children}</dl>
}

/** A date with room around it: local time first, then how far away it is and the stored UTC value. */
function FactTime({ value, empty }: { value: string | null; empty: string }) {
  if (value === null) {
    return <span className="text-muted-foreground">{empty}</span>
  }
  return (
    <span className="tabular-nums">
      <time dateTime={value}>{formatDateTime(value)}</time>
      <span className="text-muted-foreground">
        {' '}
        · {formatRelative(value)} · {formatUtc(value)}
      </span>
    </span>
  )
}

function None({ children = 'None' }: { children?: ReactNode }) {
  return <span className="text-muted-foreground">{children}</span>
}

/** The start of a device id; the whole id is in the hover text. */
function DeviceId({ id }: { id: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <code className="font-mono text-muted-foreground">{shortId(id)}</code>
      </TooltipTrigger>
      <TooltipContent className="max-w-80 font-mono break-all">{id}</TooltipContent>
    </Tooltip>
  )
}

type EventBadge = 'secondary' | 'outline' | 'warning' | 'destructive' | 'success'

const EVENT_BADGE: Record<LicenseEventType, EventBadge> = {
  activate: 'secondary',
  refresh: 'outline',
  deny: 'warning',
  transfer: 'secondary',
  deactivate: 'secondary',
  revoke: 'destructive',
  renew: 'success',
  trial: 'outline',
}

/** The badge of an event type; a type this build does not know gets the plain one. */
function eventBadge(type: string): EventBadge {
  return (EVENT_BADGE as Record<string, EventBadge | undefined>)[type] ?? 'outline'
}

/** The Mac's name, or a muted stand-in when the app sent none. */
function MacName({ name }: { name: string | null }) {
  return name === null ? <span className="font-normal text-muted-foreground">{UNNAMED_MAC}</span> : name
}

// ---------------------------------------------------------------------------
// Seats
// ---------------------------------------------------------------------------

interface SeatsProps {
  detail: LicenseDetail
  busy: boolean
  /** The activation whose seat is being freed right now, if any. */
  freeingId: number | null
  onFree: (activation: Activation) => void
}

function Seats({ detail, busy, freeingId, onFree }: SeatsProps) {
  const { license, activations } = detail
  const inUse = activations.filter((activation) => activation.deactivated_at === null).length

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>
          <h2>Seats</h2>
        </CardTitle>
        <CardDescription data-testid="seats-summary">
          {inUse} of {license.max_devices} in use. A seat is a Mac this key is active on.
        </CardDescription>
      </CardHeader>
      <CardContent className="px-0">
        {activations.length === 0 ? (
          <p className="px-3 text-muted-foreground">This key has not been activated on any Mac yet.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="pl-3">Mac</TableHead>
                <TableHead>Device id</TableHead>
                <TableHead>App</TableHead>
                <TableHead>Activated</TableHead>
                <TableHead>Last seen</TableHead>
                <TableHead>Seat</TableHead>
                <TableHead className="pr-3 text-right">
                  <span className="sr-only">Action</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {activations.map((activation) => {
                const holdsSeat = activation.deactivated_at === null
                return (
                  <TableRow key={activation.id} data-activation-id={activation.id} data-seat-in-use={holdsSeat}>
                    <TableCell className="pl-3 font-medium">
                      <MacName name={activation.device_name} />
                    </TableCell>
                    <TableCell>
                      <DeviceId id={activation.device_id} />
                    </TableCell>
                    <TableCell className="tabular-nums">{activation.app_version ?? <None>–</None>}</TableCell>
                    <TableCell>
                      <Timestamp value={activation.activated_at} />
                    </TableCell>
                    <TableCell>
                      <Timestamp value={activation.last_seen_at} relative />
                    </TableCell>
                    <TableCell>
                      {holdsSeat ? (
                        <Badge variant="success">In use</Badge>
                      ) : (
                        <span className="text-muted-foreground">
                          Freed <Timestamp value={activation.deactivated_at} format="date" />
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="py-0.5 pr-3 text-right">
                      {holdsSeat && (
                        <Button variant="outline" size="sm" disabled={busy} onClick={() => onFree(activation)}>
                          {freeingId === activation.id && <Spinner data-icon="inline-start" />}
                          Free seat
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

function EventRow({ event, macNames }: { event: LicenseEvent; macNames: Map<string, string> }) {
  const macName = event.device_id === null ? undefined : macNames.get(event.device_id)
  return (
    <TableRow data-event-type={event.type}>
      <TableCell className="pl-3">
        <Timestamp value={event.created_at} />
      </TableCell>
      <TableCell>
        <Badge variant={eventBadge(event.type)}>{eventLabel(event.type)}</Badge>
      </TableCell>
      <TableCell>
        {event.device_id === null ? (
          <None>–</None>
        ) : (
          <span className="flex items-center gap-2">
            {macName !== undefined && <span>{macName}</span>}
            <DeviceId id={event.device_id} />
          </span>
        )}
      </TableCell>
      <TableCell className="max-w-72 truncate">{event.detail ?? <None>–</None>}</TableCell>
      <TableCell className="pr-3 font-mono text-muted-foreground">{event.ip ?? '–'}</TableCell>
    </TableRow>
  )
}

function Events({ detail }: { detail: LicenseDetail }) {
  const [view, setView] = useState<'all' | 'important'>('all')
  const [page, setPage] = useState(1)

  // Names of the Macs this license knows, to put next to the device ids of their events.
  const macNames = new Map<string, string>()
  for (const activation of detail.activations) {
    if (activation.device_name !== null) {
      macNames.set(activation.device_id, activation.device_name)
    }
  }
  const events = view === 'all' ? detail.events : detail.events.filter((event) => event.type !== 'refresh')
  const pageCount = Math.max(1, Math.ceil(events.length / EVENTS_PER_PAGE))
  const shownPage = Math.min(page, pageCount)
  const rows = events.slice((shownPage - 1) * EVENTS_PER_PAGE, shownPage * EVENTS_PER_PAGE)
  const capped = detail.events_total > detail.events.length

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>
          <h2>Event history</h2>
        </CardTitle>
        <CardDescription>
          What the app and PayPal did with this key.{' '}
          {capped
            ? `Showing the newest ${formatCount(detail.events.length)} of ${formatCount(detail.events_total)} events.`
            : `${formatCount(detail.events_total)} ${plural(detail.events_total, 'event', 'events')}.`}
        </CardDescription>
        <CardAction>
          <ToggleGroup
            type="single"
            variant="outline"
            size="sm"
            aria-label="Which events to show"
            value={view}
            onValueChange={(next) => {
              if (next === 'all' || next === 'important') {
                setView(next)
                setPage(1)
              }
            }}
          >
            <ToggleGroupItem value="all">All</ToggleGroupItem>
            <ToggleGroupItem value="important">Without refreshes</ToggleGroupItem>
          </ToggleGroup>
        </CardAction>
      </CardHeader>
      <CardContent className="px-0">
        {rows.length === 0 ? (
          <p className="px-3 text-muted-foreground">
            {detail.events.length === 0 ? 'Nothing has happened with this key yet.' : 'No events other than refreshes.'}
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="pl-3">When</TableHead>
                <TableHead>Event</TableHead>
                <TableHead>Mac</TableHead>
                <TableHead>Detail</TableHead>
                <TableHead className="pr-3">IP</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((event) => (
                <EventRow key={event.id} event={event} macNames={macNames} />
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
      {events.length > EVENTS_PER_PAGE && (
        <CardContent>
          <Pager
            page={shownPage}
            pageSize={EVENTS_PER_PAGE}
            total={events.length}
            noun={['event', 'events']}
            onPageChange={setPage}
          />
        </CardContent>
      )}
    </Card>
  )
}

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

function LicenseView({ detail }: { detail: LicenseDetail }) {
  const { license, state } = detail
  const id = license.id
  const confirm = useConfirm()

  // The complete key, while it is on screen. A license that was just created starts revealed.
  const [revealedKey, setRevealedKey] = useState<string | null>(() => peekCreatedKey(id))
  const [justCreated] = useState(() => peekCreatedKey(id) !== null)
  useEffect(() => {
    forgetCreatedKey(id)
  }, [id])

  const [dialog, setDialog] = useState<{ kind: LicenseDialogKind; open: boolean }>({ kind: 'extend', open: false })
  const openDialog = (kind: LicenseDialogKind) => setDialog({ kind, open: true })

  const applied = (updated: LicenseDetail) => {
    queryClient.setQueryData(queryKeys.license(id), updated)
    invalidateAfterLicenseChange()
  }
  const failed = (title: string) => (error: unknown) => {
    toast.error(title, { description: errorMessage(error) })
  }

  const revoke = useMutation({
    mutationFn: () => revokeLicense(id),
    onSuccess: (updated) => {
      applied(updated)
      toast.success('License revoked.')
    },
    onError: failed('Could not revoke the license'),
  })
  const restore = useMutation({
    mutationFn: () => restoreLicense(id),
    onSuccess: (updated) => {
      applied(updated)
      toast.success('License restored.')
    },
    onError: failed('Could not restore the license'),
  })
  const free = useMutation({
    mutationFn: (activation: Activation) => freeSeat(id, activation.id),
    onSuccess: (updated, activation) => {
      applied(updated)
      toast.success(`Seat freed: ${activation.device_name ?? UNNAMED_MAC}.`)
    },
    onError: failed('Could not free the seat'),
  })
  const resend = useMutation({
    mutationFn: () => resendLicenseKey(id),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.auditLogs })
      toast.success(`Key email queued for ${result.to_email}.`, {
        description: dataSource === 'mock' ? 'Mock data: no email was really sent.' : undefined,
      })
    },
    onError: failed('Could not resend the key'),
  })
  const reveal = useMutation({
    mutationFn: () => revealLicenseKey(id),
    // The answer holds the key: it lives in this page's state only, not in the cache.
    gcTime: 0,
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.auditLogs })
      setRevealedKey(result.key)
    },
    onError: failed('Could not reveal the key'),
  })

  const busy = revoke.isPending || restore.isPending || free.isPending || resend.isPending || reveal.isPending

  async function askRevoke() {
    const confirmed = await confirm({
      title: 'Revoke this license?',
      description: `${license.email} loses Pro the next time the Mac checks in with the server. You can restore the license later.`,
      confirmLabel: 'Revoke license',
      destructive: true,
    })
    if (confirmed) {
      revoke.mutate()
    }
  }

  async function askFree(activation: Activation) {
    const confirmed = await confirm({
      title: 'Free this seat?',
      description: `${activation.device_name === null ? 'This Mac' : `“${activation.device_name}”`} gives up its seat, so the key can be activated on another Mac. That Mac loses Pro the next time it checks in with the server.`,
      confirmLabel: 'Free seat',
      destructive: true,
    })
    if (confirmed) {
      free.mutate(activation)
    }
  }

  async function askReveal() {
    const confirmed = await confirm({
      title: 'Reveal the complete key?',
      description:
        'The key will be shown on this screen until you hide it or leave the page. Every reveal is written to the audit log.',
      confirmLabel: 'Reveal key',
    })
    if (confirmed) {
      reveal.mutate()
    }
  }

  return (
    <>
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <h2 className="text-base font-medium" data-testid="license-email">
            {license.email}
          </h2>
          <span className="flex items-center gap-1" data-testid="license-badges" data-license-state={state}>
            <StateBadge state={state} />
            <PlanBadge plan={license.plan} />
            {license.source === 'manual' && <Badge variant="secondary">Manual</Badge>}
          </span>
          <Button variant="link" size="sm" asChild className="ml-auto">
            <Link to={`/audit?target=${encodeURIComponent(`license:${id}`)}`}>Admin actions on this license</Link>
          </Button>
        </div>

        <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="License actions">
          {/* The span carries the reason, because a disabled button shows no hover text. */}
          <span title={license.plan === 'lifetime' ? 'A lifetime license has no end date to extend.' : undefined}>
            <Button variant="outline" disabled={busy || license.plan === 'lifetime'} onClick={() => openDialog('extend')}>
              <CalendarPlusIcon data-icon="inline-start" />
              Extend
            </Button>
          </span>
          <Button variant="outline" disabled={busy} onClick={() => openDialog('plan')}>
            <ArrowLeftRightIcon data-icon="inline-start" />
            Change plan
          </Button>
          <Button variant="outline" disabled={busy} onClick={() => openDialog('devices')}>
            <LaptopIcon data-icon="inline-start" />
            Allow more Macs
          </Button>
          <Button variant="outline" disabled={busy} onClick={() => openDialog('email')}>
            <AtSignIcon data-icon="inline-start" />
            Change email
          </Button>
          <Button variant="outline" disabled={busy} onClick={() => openDialog('note')}>
            <NotebookPenIcon data-icon="inline-start" />
            {license.note === null ? 'Add note' : 'Edit note'}
          </Button>
          <Separator orientation="vertical" className="mx-1 data-vertical:h-4 data-vertical:self-center" />
          <Button variant="outline" disabled={busy} onClick={() => resend.mutate()}>
            {resend.isPending ? <Spinner data-icon="inline-start" /> : <SendIcon data-icon="inline-start" />}
            Resend key
          </Button>
          {revealedKey === null ? (
            <Button variant="outline" disabled={busy} onClick={() => void askReveal()}>
              {reveal.isPending ? <Spinner data-icon="inline-start" /> : <EyeIcon data-icon="inline-start" />}
              Reveal key
            </Button>
          ) : (
            <Button
              variant="outline"
              onClick={() => {
                setRevealedKey(null)
                reveal.reset()
              }}
            >
              <EyeOffIcon data-icon="inline-start" />
              Hide key
            </Button>
          )}
          <Separator orientation="vertical" className="mx-1 data-vertical:h-4 data-vertical:self-center" />
          {license.status === 'revoked' ? (
            <Button variant="outline" disabled={busy} onClick={() => restore.mutate()}>
              {restore.isPending ? <Spinner data-icon="inline-start" /> : <RotateCcwIcon data-icon="inline-start" />}
              Restore
            </Button>
          ) : (
            <Button variant="destructive" disabled={busy} onClick={() => void askRevoke()}>
              {revoke.isPending ? <Spinner data-icon="inline-start" /> : <BanIcon data-icon="inline-start" />}
              Revoke
            </Button>
          )}
        </div>
      </div>

      {justCreated && revealedKey !== null && (
        <Alert data-testid="created-notice">
          <CircleCheckIcon />
          <AlertTitle>License created</AlertTitle>
          <AlertDescription>
            The new key is shown below. Copy it now or send it with Resend key. Later it stays hidden until you use
            Reveal key.
          </AlertDescription>
        </Alert>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card size="sm">
          <CardHeader>
            <CardTitle>
              <h2>License</h2>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <Facts>
              <Fact label="Plan">{PLAN_LABEL[license.plan]}</Fact>
              <Fact label="Status">
                <span className="flex flex-wrap items-center gap-2">
                  <StateBadge state={state} />
                  {state === 'expired' && license.expires_at !== null && (
                    <span className="text-muted-foreground">ran out {formatRelative(license.expires_at)}</span>
                  )}
                </span>
              </Fact>
              <Fact label="Paid through">
                <FactTime value={license.period_end} empty="No end date (lifetime)" />
              </Fact>
              <Fact label="Expires">
                <FactTime value={license.expires_at} empty="Never" />
              </Fact>
              <Fact label="Auto-renew">
                {license.auto_renew ? 'On, through PayPal. Expires includes the renewal buffer.' : <None>Off</None>}
              </Fact>
              <Fact label="Macs allowed">{license.max_devices}</Fact>
              <Fact label="Transfers used">{license.transfers_used}</Fact>
              <Fact label="Created">
                <FactTime value={license.created_at} empty="–" />
              </Fact>
              <Fact label="Updated">
                <FactTime value={license.updated_at} empty="–" />
              </Fact>
            </Facts>
          </CardContent>
        </Card>

        <Card size="sm">
          <CardHeader>
            <CardTitle>
              <h2>Buyer and key</h2>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <Facts>
              <Fact label="Email">
                <span className="flex items-center gap-1.5">
                  <span className="truncate">{license.email}</span>
                  <CopyButton value={license.email} variant="ghost" size="icon-xs" aria-label="Copy email" />
                </span>
              </Fact>
              <Fact label="Key">
                <span className="flex flex-wrap items-center gap-2">
                  <code
                    className="font-mono text-[0.8125rem] tracking-wide"
                    data-testid="license-key"
                    data-revealed={revealedKey !== null}
                  >
                    {revealedKey ?? maskedKey(license.key_hint)}
                  </code>
                  {revealedKey !== null && <CopyButton value={revealedKey} label="Copy" size="xs" />}
                </span>
              </Fact>
              <Fact label="Source">{SOURCE_LABEL[license.source]}</Fact>
              <Fact label="PayPal payer id">
                {license.payer_id === null ? (
                  <None />
                ) : (
                  <code className="font-mono" data-testid="payer-id">
                    {license.payer_id}
                  </code>
                )}
              </Fact>
              <Fact label="Subscription id">
                {license.paypal_subscription_id === null ? (
                  <None />
                ) : (
                  <code className="font-mono" data-testid="subscription-id">
                    {license.paypal_subscription_id}
                  </code>
                )}
              </Fact>
              <Fact label="Note">
                {license.note === null ? (
                  <None>No note</None>
                ) : (
                  <span className="whitespace-pre-wrap" data-testid="license-note">
                    {license.note}
                  </span>
                )}
              </Fact>
            </Facts>
          </CardContent>
        </Card>
      </div>

      <Seats detail={detail} busy={busy} freeingId={free.isPending ? (free.variables?.id ?? null) : null} onFree={(activation) => void askFree(activation)} />

      <Card size="sm">
        <CardHeader>
          <CardTitle>
            <h2>Payments</h2>
          </CardTitle>
          <CardDescription>
            Not available yet. The PayPal payments and refunds of this license are listed here from phase W3.
          </CardDescription>
        </CardHeader>
      </Card>

      <Events detail={detail} />

      <LicenseActionDialog
        kind={dialog.kind}
        open={dialog.open}
        onOpenChange={(open) => setDialog((current) => ({ ...current, open }))}
        detail={detail}
      />
    </>
  )
}

function DetailSkeleton() {
  return (
    <div className="flex flex-col gap-4" aria-busy="true" aria-label="Loading the license">
      <Skeleton className="h-6 w-72" />
      <Skeleton className="h-7 w-full max-w-3xl" />
      <div className="grid gap-4 lg:grid-cols-2">
        <Skeleton className="h-56" />
        <Skeleton className="h-56" />
      </div>
      <Skeleton className="h-32" />
      <Skeleton className="h-64" />
    </div>
  )
}

function LicenseNotFound() {
  return (
    <EmptyState
      icon={FileQuestionIcon}
      title="License not found"
      description="There is no license with this id. It may have been opened from an old link."
    >
      <Button variant="outline" asChild>
        <Link to="/licenses">Back to licenses</Link>
      </Button>
    </EmptyState>
  )
}

function LoadedLicense({ id }: { id: number }) {
  const license = useQuery({ queryKey: queryKeys.license(id), queryFn: () => getLicense(id) })

  if (license.isError && isNotFound(license.error)) {
    return <LicenseNotFound />
  }
  if (license.data === undefined) {
    if (license.isError) {
      return (
        <ErrorState
          title="Could not load this license"
          error={license.error}
          onRetry={() => void license.refetch()}
          retrying={license.isFetching}
        />
      )
    }
    return <DetailSkeleton />
  }
  return (
    <>
      {license.isError && (
        <RefreshFailedNotice error={license.error} onRetry={() => void license.refetch()} retrying={license.isFetching} />
      )}
      <LicenseView detail={license.data} />
    </>
  )
}

export function LicenseDetailPage() {
  const params = useParams()
  const id = Number(params.id)
  const valid = Number.isSafeInteger(id) && id > 0 && String(id) === params.id
  usePageTitle(valid ? `License #${id}` : 'License')

  if (!valid) {
    return <LicenseNotFound />
  }
  // The key remounts everything when the admin moves from one license to another,
  // so a revealed key or an open dialog never carries over.
  return <LoadedLicense key={id} id={id} />
}
