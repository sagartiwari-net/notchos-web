#!/usr/bin/env node
/**
 * Checks the data module (src/api) without a browser:
 *
 *   npm run check:data
 *
 * Part 1 looks at the mock's seed data: are the rows consistent with each other and with the
 *        schema rules (dates in the wire format, a lifetime license has no dates, and so on).
 * Part 2 calls every function of the module the way the pages do, through the real transport
 *        code, and checks the answers: paging, filters, search, every license action, the
 *        audit rows they leave, validation errors, and the forced states (?mock=...).
 *
 * The TypeScript sources are loaded through Vite (no server is started, no port is opened).
 * The few browser globals the mock touches are stubbed below.
 * Exit code 0 means every check passed.
 *
 * Part 2 is written against the public functions only, so in W2 it can be pointed at the
 * real API (with a database seeded to match) as a contract test. Part 1 goes away with the mock.
 */

import path from 'node:path'
import process from 'node:process'

import { createServer } from 'vite'

const DAY = 86_400_000
const HOUR = 3_600_000

// ---------------------------------------------------------------------------
// Browser globals the mock touches
// ---------------------------------------------------------------------------

const storage = new Map()
globalThis.window = {
  location: { search: '' },
  localStorage: {
    getItem: (key) => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => void storage.set(key, String(value)),
    removeItem: (key) => void storage.delete(key),
  },
  // No artificial latency here.
  setTimeout: (callback) => setTimeout(callback, 0),
}

/** Sets the ?mock= flags the mock reads from the page address. */
function setFlags(flags) {
  window.location.search = flags === '' ? '' : `?mock=${flags}`
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

let failed = 0
let total = 0

function check(name, passed, detail = '') {
  total++
  if (!passed) {
    failed++
  }
  console.log(`  ${passed ? 'ok  ' : 'FAIL'} ${name}${detail === '' ? '' : `  [${detail}]`}`)
}

function section(title) {
  console.log(`\n${title}`)
}

/** The error a call rejects with, or null if it resolved. */
const errorOf = (promise) =>
  promise.then(
    () => null,
    (error) => error,
  )

const WIRE_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/
const KEY = /^NOS-[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}$/
const wireTime = (ms) => `${new Date(ms).toISOString().slice(0, 19)}Z`

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

const vite = await createServer({
  root: path.resolve(import.meta.dirname, '..'),
  // Middleware mode without HMR: Vite only compiles modules on request, it listens nowhere.
  server: { middlewareMode: true, hmr: false, ws: false },
  appType: 'custom',
  logLevel: 'error',
})

try {
  const { buildSeed } = await vite.ssrLoadModule('/src/api/mock/seed.ts')
  const api = await vite.ssrLoadModule('/src/api/index.ts')

  // =======================================================================================
  // Part 1. The seed
  // =======================================================================================

  const now = Date.now()
  const db = buildSeed(now)
  const inPast = (date) => Date.parse(date) <= now
  const stateOf = (license) =>
    license.status === 'revoked'
      ? 'revoked'
      : license.expires_at !== null && Date.parse(license.expires_at) <= now
        ? 'expired'
        : 'active'

  section('Part 1. Seed data')
  console.log(
    `  ${db.licenses.length} licenses, ${db.activations.length} activations, ${db.events.length} events, ` +
      `${db.trials.length} trials, ${db.payments.length} payments, ${db.audit.length} audit rows`,
  )
  check('the same seed comes out every time', JSON.stringify(buildSeed(now)) === JSON.stringify(db))

  const everyDate = [
    ...db.licenses.flatMap((l) => [l.created_at, l.updated_at, l.period_end, l.expires_at]),
    ...db.activations.flatMap((a) => [a.activated_at, a.last_seen_at, a.deactivated_at]),
    ...db.events.map((e) => e.created_at),
    ...db.trials.flatMap((t) => [t.started_at, t.expires_at]),
    ...db.payments.map((p) => p.created_at),
    ...db.audit.map((r) => r.created_at),
  ].filter((date) => date !== null)
  check('every date is UTC with whole seconds (2026-11-10T03:36:27Z)', everyDate.every((date) => WIRE_DATE.test(date)))

  check(
    'license ids run 1..n in the order the licenses were created',
    db.licenses.every((l, i) => l.id === i + 1 && (i === 0 || db.licenses[i - 1].created_at <= l.created_at)),
  )
  check(
    'keys are NOS-XXXXX-XXXXX-XXXXX-XXXXX without 0 O 1 I, all different, key_hint is the last 4',
    db.licenses.every((l) => KEY.test(l.key) && l.key_hint === l.key.slice(-4)) &&
      new Set(db.licenses.map((l) => l.key)).size === db.licenses.length,
  )
  check(
    'created_at and updated_at are in the past, updated is not before created',
    db.licenses.every((l) => inPast(l.created_at) && inPast(l.updated_at) && l.updated_at >= l.created_at),
  )
  check(
    'lifetime: no period_end, no expires_at, no auto-renew, no subscription',
    db.licenses
      .filter((l) => l.plan === 'lifetime')
      .every((l) => l.period_end === null && l.expires_at === null && !l.auto_renew && l.paypal_subscription_id === null),
  )
  check(
    'monthly: has period_end and expires_at, and expires_at is not before period_end',
    db.licenses
      .filter((l) => l.plan === 'monthly')
      .every((l) => l.period_end !== null && l.expires_at !== null && l.expires_at >= l.period_end),
  )
  check(
    'auto-renew on: active PayPal subscription paid into the future, expires_at = period_end + 24 h buffer',
    db.licenses
      .filter((l) => l.auto_renew)
      .every(
        (l) =>
          l.plan === 'monthly' &&
          l.source === 'paypal' &&
          l.status === 'active' &&
          /^I-[A-Z2-9]{12}$/.test(l.paypal_subscription_id ?? '') &&
          Date.parse(l.period_end) > now &&
          Date.parse(l.expires_at) - Date.parse(l.period_end) === 24 * HOUR,
      ),
  )
  check(
    'auto-renew off: expires_at = period_end (no buffer)',
    db.licenses.filter((l) => l.plan === 'monthly' && !l.auto_renew).every((l) => l.expires_at === l.period_end),
  )
  check(
    'manual licenses have no payer id and no subscription; PayPal ones have a 13-character payer id',
    db.licenses.every((l) =>
      l.source === 'manual'
        ? l.payer_id === null && l.paypal_subscription_id === null
        : /^[A-Z2-9]{13}$/.test(l.payer_id ?? ''),
    ),
  )
  check(
    'emails use reserved example domains only',
    db.licenses.every((l) => /@(example\.(com|org|net)|[a-z]+\.example)$/.test(l.email)),
  )

  const activationsOf = new Map()
  for (const activation of db.activations) {
    activationsOf.set(activation.license_id, [...(activationsOf.get(activation.license_id) ?? []), activation])
  }
  check(
    'activation ids run 1..n in time order; device ids are 64 hex characters',
    db.activations.every(
      (a, i) =>
        a.id === i + 1 &&
        (i === 0 || db.activations[i - 1].activated_at <= a.activated_at) &&
        /^[0-9a-f]{64}$/.test(a.device_id),
    ),
  )
  check(
    'an activation is after its license was created, last seen is not before it, a freed seat was freed after it',
    db.activations.every(
      (a) =>
        a.activated_at >= db.licenses[a.license_id - 1].created_at &&
        inPast(a.last_seen_at) &&
        a.last_seen_at >= a.activated_at &&
        (a.deactivated_at === null || (inPast(a.deactivated_at) && a.deactivated_at >= a.activated_at)),
    ),
  )
  check(
    'no key was activated or moved to another Mac after it had expired',
    db.activations.every((a) => {
      const license = db.licenses[a.license_id - 1]
      return license.expires_at === null || a.activated_at <= license.expires_at
    }),
  )
  check(
    'no license has more seats in use than max_devices',
    db.licenses.every(
      (l) => (activationsOf.get(l.id) ?? []).filter((a) => a.deactivated_at === null).length <= l.max_devices,
    ),
  )
  check(
    'transfers_used is never more than the Macs the license moved away from',
    db.licenses.every((l) => l.transfers_used <= Math.max(0, (activationsOf.get(l.id) ?? []).length - 1)),
  )
  check(
    'event ids run 1..n in time order; an event is in the past and after its license was created',
    db.events.every(
      (e, i) =>
        e.id === i + 1 &&
        (i === 0 || db.events[i - 1].created_at <= e.created_at) &&
        inPast(e.created_at) &&
        e.created_at >= db.licenses[e.license_id - 1].created_at,
    ),
  )
  check(
    'for every seat in use, last_seen_at is the time of its newest activate / transfer / refresh event',
    db.activations
      .filter((a) => a.deactivated_at === null)
      .every((a) => {
        const newest = db.events
          .filter(
            (e) =>
              e.license_id === a.license_id &&
              e.device_id === a.device_id &&
              ['activate', 'transfer', 'refresh'].includes(e.type),
          )
          .reduce((latest, e) => (e.created_at > latest ? e.created_at : latest), '')
        return newest === a.last_seen_at
      }),
  )

  const activatedDevices = new Set(db.activations.map((a) => a.device_id))
  const runningTrials = db.trials.filter((t) => Date.parse(t.expires_at) > now).length
  const convertedTrials = db.trials.filter((t) => activatedDevices.has(t.device_id))
  check(
    'trials: one per device, 7 days long, started in the past',
    new Set(db.trials.map((t) => t.device_id)).size === db.trials.length &&
      db.trials.every((t) => inPast(t.started_at) && Date.parse(t.expires_at) - Date.parse(t.started_at) === 7 * DAY),
  )
  check(
    'some trials are running and some converted; a converted trial started before the key was activated',
    runningTrials >= 5 &&
      convertedTrials.length >= 10 &&
      convertedTrials.every((t) =>
        db.activations.filter((a) => a.device_id === t.device_id).every((a) => a.activated_at > t.started_at),
      ),
    `${runningTrials} running, ${convertedTrials.length} converted of ${db.trials.length}`,
  )
  check(
    'audit ids run 1..n in time order; a row about a license is not older than that license',
    db.audit.every(
      (r, i) =>
        r.id === i + 1 &&
        inPast(r.created_at) &&
        (i === 0 || db.audit[i - 1].created_at <= r.created_at) &&
        (!r.target.startsWith('license:') || r.created_at >= db.licenses[Number(r.target.slice(8)) - 1].created_at),
    ),
  )
  check(
    'every manual license has the audit row of its creation',
    db.licenses
      .filter((l) => l.source === 'manual')
      .every((l) => db.audit.some((r) => r.action === 'license.create' && r.target === `license:${l.id}`)),
  )

  const expiringSoon = db.licenses.filter(
    (l) => stateOf(l) === 'active' && l.expires_at !== null && Date.parse(l.expires_at) <= now + 7 * DAY,
  ).length
  const countBy = (state) => db.licenses.filter((l) => stateOf(l) === state).length
  check(
    'there are active, expired, revoked and soon-expiring licenses to show',
    countBy('active') > 0 && countBy('expired') > 0 && countBy('revoked') > 0 && expiringSoon >= 5,
    `${countBy('active')} active, ${countBy('expired')} expired, ${countBy('revoked')} revoked, ${expiringSoon} expiring within 7 days`,
  )
  check(
    'a few rows have no Mac name, app version or IP, as the schema allows',
    db.activations.some((a) => a.device_name === null) &&
      db.activations.some((a) => a.app_version === null) &&
      db.trials.some((t) => t.ip === null),
  )

  // =======================================================================================
  // Part 2. The module's functions
  // =======================================================================================

  section('Part 2. Session')
  let error = await errorOf(api.listLicenses())
  check('signed out: a call rejects with not_signed_in (401)', error instanceof api.ApiError && error.code === 'not_signed_in' && error.status === 401)
  check('signed out: getSession answers null', (await api.getSession()) === null)
  error = await errorOf(api.login({ username: 'sagar', password: '', code: '123456' }))
  check('login without a password: invalid_credentials (401)', error?.code === 'invalid_credentials' && error.status === 401)
  error = await errorOf(api.login({ username: 'sagar', password: 'x', code: '12345' }))
  check('login with 5 digits: invalid_credentials', error?.code === 'invalid_credentials')
  const session = await api.login({ username: 'sagar', password: 'anything', code: '000000' })
  check('login with any password and any 6 digits', session.admin.username === 'sagar' && WIRE_DATE.test(session.expires_at))
  check('getSession after login', (await api.getSession())?.admin.username === 'sagar')

  section('Part 2. Licenses: paging, filters, search')
  const firstPage = await api.listLicenses()
  check(
    'default: page 1 of 50, newest first',
    firstPage.items.length === 50 && firstPage.page === 1 && firstPage.page_size === 50 && firstPage.total === db.licenses.length && firstPage.items[0].id === db.licenses.length,
    `total ${firstPage.total}`,
  )
  const lastPageNumber = Math.ceil(db.licenses.length / 50)
  const lastPage = await api.listLicenses({ page: lastPageNumber })
  check('the last page has the remainder and ends with license 1', lastPage.items.length === db.licenses.length - 50 * (lastPageNumber - 1) && lastPage.items.at(-1).id === 1)
  const beyond = await api.listLicenses({ page: lastPageNumber + 2 })
  check('a page past the end is empty with the same total', beyond.items.length === 0 && beyond.total === db.licenses.length)
  const smallPage = await api.listLicenses({ page_size: 25, page: 2 })
  check('page_size 25, page 2', smallPage.items.length === 25 && smallPage.items[0].id === db.licenses.length - 25)
  for (const state of ['active', 'expired', 'revoked']) {
    const answer = await api.listLicenses({ state, page_size: 100 })
    check(`state=${state}`, answer.total === countBy(state) && answer.items.every((item) => item.state === state), `${answer.total}`)
  }
  for (const plan of ['monthly', 'lifetime']) {
    const answer = await api.listLicenses({ plan, page_size: 100 })
    check(`plan=${plan}`, answer.total > 0 && answer.items.every((item) => item.plan === plan), `${answer.total}`)
  }
  const expiring = await api.listLicenses({ expiring: true, page_size: 100 })
  check(
    'expiring=1: active and expiring within 7 days',
    expiring.total === expiringSoon && expiring.items.every((item) => item.state === 'active' && Date.parse(item.expires_at) <= Date.now() + 7 * DAY),
    `${expiring.total}`,
  )
  const combined = await api.listLicenses({ plan: 'monthly', state: 'active', expiring: true })
  check('filters combine', combined.total > 0 && combined.items.every((item) => item.plan === 'monthly' && item.state === 'active'))
  check(
    'a list never carries a key, a key hash or an encrypted key',
    firstPage.items.every((item) => !('key' in item) && !('key_hash' in item) && !('key_enc' in item)),
  )

  // A subscribed PayPal license with its seat in use: it has every id the search knows.
  const sample = db.licenses.find(
    (l) => l.auto_renew && (activationsOf.get(l.id) ?? []).some((a) => a.deactivated_at === null),
  )
  let found = await api.listLicenses({ q: sample.email.slice(0, 9).toUpperCase() })
  check('search: part of the email, any case', found.items.some((item) => item.id === sample.id))
  found = await api.listLicenses({ q: sample.key_hint.toLowerCase() })
  check('search: the key ending', found.items.some((item) => item.id === sample.id))
  found = await api.listLicenses({ q: sample.key.toLowerCase().replaceAll('-', ' ') })
  check('search: the complete key in another spelling', found.total === 1 && found.items[0].id === sample.id)
  found = await api.listLicenses({ q: sample.payer_id })
  check('search: PayPal payer id', found.items.some((item) => item.id === sample.id) && found.items.every((item) => item.payer_id === sample.payer_id))
  found = await api.listLicenses({ q: sample.paypal_subscription_id })
  check('search: PayPal subscription id', found.total === 1 && found.items[0].id === sample.id)
  found = await api.listLicenses({ q: 'zzzz-no-such-thing' })
  check('search: nothing matches', found.total === 0 && found.items.length === 0)

  section('Part 2. License detail and actions')
  const auditBefore = (await api.listAuditLog()).total
  let detail = await api.getLicense(sample.id)
  check(
    'detail: license, state, activations, events, events_total; no key',
    detail.license.id === sample.id && detail.state === 'active' && Array.isArray(detail.activations) && Array.isArray(detail.events) && detail.events_total >= detail.events.length && !('key' in detail.license),
  )
  error = await errorOf(api.getLicense(999_999))
  check('unknown id: not_found (404)', error?.code === 'not_found' && error.status === 404)

  detail = await api.revokeLicense(sample.id)
  check('revoke: status revoked, newest event is revoke', detail.license.status === 'revoked' && detail.state === 'revoked' && detail.events[0].type === 'revoke')
  let auditCount = (await api.listAuditLog()).total
  await api.revokeLicense(sample.id)
  check('revoke again: nothing changes', (await api.listAuditLog()).total === auditCount)
  detail = await api.restoreLicense(sample.id)
  check('restore: active again', detail.license.status === 'active' && detail.state === 'active')

  const seat = detail.activations.find((a) => a.deactivated_at === null)
  detail = await api.freeSeat(sample.id, seat.id)
  check('free seat: that activation is closed, newest event is deactivate', detail.activations.find((a) => a.id === seat.id).deactivated_at !== null && detail.events[0].type === 'deactivate')
  error = await errorOf(api.freeSeat(sample.id, 999_999))
  check('free seat: unknown activation: not_found', error?.code === 'not_found')

  const extended = wireTime(Date.parse(detail.license.period_end) + 30 * DAY)
  detail = await api.extendLicense(sample.id, { period_end: extended })
  check('extend: period_end is the date sent, expires_at adds the 24 h buffer', detail.license.period_end === extended && Date.parse(detail.license.expires_at) - Date.parse(extended) === 24 * HOUR)
  auditCount = (await api.listAuditLog()).total
  await api.extendLicense(sample.id, { period_end: extended })
  await api.extendLicense(sample.id, { period_end: extended.replace('Z', '.750Z') })
  check('extend again to the same date (also with fractional seconds): nothing changes', (await api.listAuditLog()).total === auditCount)
  error = await errorOf(api.extendLicense(sample.id, { period_end: wireTime(Date.now() + HOUR) }))
  check('extend to an earlier date: bad_request on period_end', error?.code === 'bad_request' && error.status === 400 && typeof error.fields.period_end === 'string', error?.fields.period_end)

  detail = await api.changeLicensePlan(sample.id, { plan: 'lifetime' })
  check('change plan to lifetime: dates cleared, auto-renew off', detail.license.plan === 'lifetime' && detail.license.period_end === null && detail.license.expires_at === null && detail.license.auto_renew === false)
  error = await errorOf(api.changeLicensePlan(sample.id, { plan: 'lifetime' }))
  check('change plan to the plan it has: conflict (409)', error?.code === 'conflict' && error.status === 409)
  error = await errorOf(api.extendLicense(sample.id, { period_end: extended }))
  check('extend a lifetime license: conflict', error?.code === 'conflict')
  const monthlyUntil = wireTime(Date.now() + 30 * DAY)
  detail = await api.changeLicensePlan(sample.id, { plan: 'monthly', period_end: monthlyUntil })
  check('change plan to monthly: period_end and expires_at are the date sent', detail.license.plan === 'monthly' && detail.license.period_end === monthlyUntil && detail.license.expires_at === monthlyUntil)

  detail = await api.setLicenseMaxDevices(sample.id, { max_devices: 3 })
  check('allow more Macs', detail.license.max_devices === 3)
  error = await errorOf(api.setLicenseMaxDevices(sample.id, { max_devices: 0 }))
  check('0 Macs: bad_request on max_devices', error?.code === 'bad_request' && typeof error.fields.max_devices === 'string')

  const resent = await api.resendLicenseKey(sample.id)
  check('resend key: answers the address', resent.to_email === sample.email)
  const revealed = await api.revealLicenseKey(sample.id)
  check('reveal key: answers the complete key', revealed.key === sample.key)
  detail = await api.changeLicenseEmail(sample.id, { email: 'new.address@example.org' })
  check('change email', detail.license.email === 'new.address@example.org')
  error = await errorOf(api.changeLicenseEmail(sample.id, { email: 'not-an-email' }))
  check('change email to something that is not one: bad_request on email', error?.code === 'bad_request' && typeof error.fields.email === 'string')
  detail = await api.setLicenseNote(sample.id, { note: '  Called about a refund  ' })
  check('set note (trimmed)', detail.license.note === 'Called about a refund')
  detail = await api.setLicenseNote(sample.id, { note: '' })
  check('an empty note clears it', detail.license.note === null)

  const createdLifetime = await api.createLicense({ email: 'team@example.com', plan: 'lifetime', max_devices: 2, note: 'Team' })
  check(
    'create lifetime: answers the license and its key once',
    KEY.test(createdLifetime.key) && createdLifetime.license.key_hint === createdLifetime.key.slice(-4) && createdLifetime.license.source === 'manual' && createdLifetime.license.id === db.licenses.length + 1 && createdLifetime.license.max_devices === 2 && !('key' in createdLifetime.license),
  )
  const createdMonthly = await api.createLicense({ email: 'gift@example.com', plan: 'monthly', period_end: monthlyUntil })
  check('create monthly: 1 Mac by default, ends on the date sent', createdMonthly.license.plan === 'monthly' && createdMonthly.license.expires_at === monthlyUntil && createdMonthly.license.max_devices === 1)
  error = await errorOf(api.createLicense({ email: 'x', plan: 'monthly' }))
  check('create with a bad email and no end date: bad_request on both', error?.code === 'bad_request' && typeof error.fields.email === 'string' && typeof error.fields.period_end === 'string')
  const afterCreate = await api.listLicenses()
  check('the new licenses are first in the list', afterCreate.total === db.licenses.length + 2 && afterCreate.items[0].id === createdMonthly.license.id && afterCreate.items[1].id === createdLifetime.license.id)

  section('Part 2. Audit log')
  const own = await api.listAuditLog({ target: `license:${sample.id}`, page_size: 100 })
  const expectedActions = [
    'license.set_note',
    'license.set_note',
    'license.change_email',
    'license.reveal_key',
    'license.resend_key',
    'license.set_max_devices',
    'license.change_plan',
    'license.change_plan',
    'license.extend',
    'license.free_seat',
    'license.restore',
    'license.revoke',
  ]
  check(
    'every action left one row, newest first',
    JSON.stringify(own.items.slice(0, expectedActions.length).map((row) => row.action)) === JSON.stringify(expectedActions),
    own.items.slice(0, expectedActions.length).map((row) => row.action).join(', '),
  )
  check('the rows name the signed-in admin', own.items.every((row) => row.admin_username === 'sagar' && row.admin_id === 1))
  check('12 actions and 2 new licenses made 14 rows', (await api.listAuditLog()).total === auditBefore + 14)
  const revokes = await api.listAuditLog({ action: 'license.revoke' })
  check('action filter', revokes.total > 0 && revokes.items.every((row) => row.action === 'license.revoke'))

  section('Part 2. Dashboard, trials, settings')
  const dashboard = await api.getDashboard({ today_start: wireTime(new Date().setHours(0, 0, 0, 0)) })
  check(
    'dashboard: every counter is there and the windows nest (today <= 7 days <= 30 days)',
    dashboard.currency === 'USD' &&
      dashboard.sales.today.count <= dashboard.sales.last_7_days.count &&
      dashboard.sales.last_7_days.count <= dashboard.sales.last_30_days.count &&
      /^\d+\.\d{2}$/.test(dashboard.sales.last_30_days.amount) &&
      dashboard.active_licenses.monthly > 0 &&
      dashboard.active_licenses.lifetime > 0 &&
      dashboard.monthly_subscribers <= dashboard.active_licenses.monthly &&
      dashboard.trials.converted_total <= dashboard.trials.started_total &&
      dashboard.trials.converted_30_days <= dashboard.trials.started_30_days &&
      Number.isInteger(dashboard.failed_emails) &&
      Number.isInteger(dashboard.unprocessed_webhooks) &&
      Number.isInteger(dashboard.open_disputes),
    JSON.stringify(dashboard.sales),
  )

  const running = await api.listTrials({ state: 'active', page_size: 100 })
  check('trials: state=active', running.total === runningTrials && running.items.every((trial) => trial.state === 'active'))
  const allTrials = await api.listTrials({ page_size: 100 })
  check(
    'trials: newest first, converted ones name their license',
    allTrials.total === db.trials.length &&
      allTrials.items.every((trial, i) => i === 0 || allTrials.items[i - 1].started_at >= trial.started_at) &&
      allTrials.items.some((trial) => trial.converted_license_id !== null),
  )

  const settings = await api.getSettings()
  check('settings: read', settings.trial_days === 7 && settings.transfer_limit === 2 && settings.renewal_buffer_hours === 24 && settings.paypal_plan_id === null)
  const { paypal_plan_id: _readOnly, server_time: _serverTime, ...editable } = settings
  let saved = await api.updateSettings({ ...editable, trial_days: 10, prices: { ...editable.prices, monthly: '5.5' } })
  check('settings: save; a price comes back with two decimals', saved.trial_days === 10 && saved.prices.monthly === '5.50')
  check(
    'settings: the change is one audit row that names what changed',
    (await api.listAuditLog({ action: 'settings.update' })).items[0].detail === 'prices.monthly: 4.99 → 5.50; trial_days: 7 → 10',
  )
  error = await errorOf(api.updateSettings({ ...editable, download_url: 'http://insecure.example', trial_days: 0 }))
  check('settings: bad values come back per field', error?.code === 'bad_request' && typeof error.fields.download_url === 'string' && typeof error.fields.trial_days === 'string', JSON.stringify(error?.fields))
  saved = await api.updateSettings({ ...editable, trial_days: 10, prices: { monthly: null, lifetime: editable.prices.lifetime }, download_url: null })
  check('settings: null clears a value that may be unset', saved.prices.monthly === null && saved.download_url === null && saved.prices.lifetime === editable.prices.lifetime)
  check('answers carry server_time and the module is not bothered by it', WIRE_DATE.test(saved.server_time))

  section('Part 2. Forced states (?mock=...)')
  setFlags('error')
  error = await errorOf(api.listLicenses())
  check('error: reads fail with server_error (500)', error?.code === 'server_error' && error.status === 500)
  check('error: the session still answers, so the frame can show the page error', (await api.getSession()) !== null)
  setFlags('empty')
  const fresh = await api.getSettings()
  check(
    'empty: lists are empty, counters are zero',
    (await api.listLicenses()).total === 0 && (await api.listTrials()).total === 0 && (await api.listAuditLog()).total === 0 && (await api.getDashboard()).active_licenses.monthly === 0,
  )
  check(
    'empty: settings as after the first migration (three numbers, the rest not set)',
    fresh.prices.monthly === null && fresh.prices.lifetime === null && fresh.download_url === null && fresh.app_version === null && Number.isInteger(fresh.trial_days),
  )
  setFlags('write-error')
  error = await errorOf(api.revokeLicense(sample.id))
  check('write-error: writes fail with server_error', error?.code === 'server_error')
  check('write-error: nothing was changed', (await api.getLicense(sample.id)).license.status === 'active')
  setFlags('login-error')
  error = await errorOf(api.login({ username: 'a', password: 'b', code: '123456' }))
  check('login-error: invalid_credentials', error?.code === 'invalid_credentials')
  setFlags('login-rate-limited')
  error = await errorOf(api.login({ username: 'a', password: 'b', code: '123456' }))
  check('login-rate-limited: rate_limited (429) with the seconds to wait', error?.code === 'rate_limited' && error.status === 429 && error.retryAfterSeconds === 840)
  setFlags('offline')
  error = await errorOf(api.getSession())
  check('offline: network_error with status 0', error?.code === 'network_error' && error.status === 0)
  setFlags('')

  section('Part 2. Sign out')
  await api.logout()
  check('logout: the session is gone', (await api.getSession()) === null)
  error = await errorOf(api.getSettings())
  check('after logout: not_signed_in', error?.code === 'not_signed_in')
} finally {
  await vite.close()
}

console.log(`\n${total - failed} of ${total} checks passed.`)
process.exitCode = failed === 0 ? 0 : 1
