/**
 * Mock data for the admin shell. Deleted in W2 together with the rest of src/api/mock.
 *
 * The data is generated, not hand-written: a seeded random generator gives the same people,
 * keys and ids on every load, while every date is placed relative to "now", so "sales today",
 * "expiring soon" and "on trial" always have rows. Rows are consistent with each other:
 * a transfer has two activations and an event, a renewal has a payment and an event, a manual
 * license has its audit row, and so on.
 *
 * Nothing here is real. Email addresses use reserved example domains, IP addresses use the
 * documentation ranges, and the prices are placeholders, not a decision (plan decision 12).
 */

import type {
  Activation,
  AuditLogEntry,
  License,
  LicenseEvent,
  LicensePlan,
  LicenseStatus,
  Money,
  Settings,
  SeatMove,
  Trial,
  TrialLead,
} from '../types'

export const MINUTE = 60_000
export const HOUR = 60 * MINUTE
export const DAY = 24 * HOUR

/** The mock keeps the complete key in memory. The real server stores key_hash + key_enc only. */
export interface LicenseRow extends License {
  key: string
}

export type AuditRow = Omit<AuditLogEntry, 'admin_username'>

/** Only used to add up the dashboard sales. The Payments page and its type arrive in W3. */
export interface PaymentRow {
  id: number
  license_id: number
  kind: 'order' | 'subscription' | 'refund'
  amount: Money
  created_at: string
}

export interface MockDb {
  admin: { id: number; username: string }
  licenses: LicenseRow[]
  activations: Activation[]
  events: LicenseEvent[]
  trials: Trial[]
  trialLeads: TrialLead[]
  seatMoves: SeatMove[]
  payments: PaymentRow[]
  audit: AuditRow[]
  settings: Settings
  /** Clear SMTP password; never returned in Settings. */
  smtpPass: string | null
  attention: { failed_emails: number; unprocessed_webhooks: number; open_disputes: number }
  nextId: { license: number; activation: number; event: number; audit: number; seatMove: number; trialLead: number }
}

export const MOCK_ADMIN_ID = 1
export const MOCK_ADMIN_IP = '203.0.113.7'
export const DEFAULT_ADMIN_USERNAME = 'admin'

/** NOS-XXXXX-XXXXX-XXXXX-XXXXX, without 0 O 1 I (plan W1 item 4). */
export const KEY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const PAYPAL_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const HEX = '0123456789abcdef'

const LICENSE_COUNT = 342
const TRIAL_COUNT = 260

const FIRST_NAMES = [
  'Aarav', 'Maya', 'Liam', 'Sofia', 'Noah', 'Emma', 'Kenji', 'Yuki', 'Lukas', 'Hannah',
  'Mateo', 'Camila', 'Oliver', 'Amelia', 'Ravi', 'Priya', 'Jonas', 'Freya', 'Diego', 'Valentina',
  'Ethan', 'Chloe', 'Hiro', 'Sakura', 'Felix', 'Clara', 'Omar', 'Layla', 'Tomas', 'Elena',
  'Arjun', 'Ananya', 'Leo', 'Zoe', 'Mikkel', 'Astrid', 'Pablo', 'Lucia', 'Daniel', 'Nora',
  'Kai', 'Mila', 'Samir', 'Leila', 'Viktor', 'Ingrid', 'Marco', 'Giulia', 'Theo', 'Iris',
]

const LAST_NAMES = [
  'Sharma', 'Keller', 'Nakamura', 'Rossi', 'Andersson', 'Silva', 'Dubois', 'Novak', 'Tanaka', 'Meyer',
  'Garcia', 'Okafor', 'Lindqvist', 'Fischer', 'Moreau', 'Costa', 'Kowalski', 'Jensen', 'Petrov', 'Haddad',
  'Iyer', 'Bianchi', 'Schmidt', 'Larsen', 'Mendes', 'Yamamoto', 'Varga', 'Olsen', 'Romero', 'Weber',
  'Kapoor', 'Hoffmann', 'Nilsson', 'Castro', 'Bauer', 'Sato', 'Marin', 'Dahl', 'Reyes', 'Vogel',
]

const EMAIL_DOMAINS = [
  'example.com', 'example.com', 'example.com', 'example.org', 'example.net',
  'mail.example', 'studio.example', 'corp.example', 'post.example', 'uni.example',
]

const MAC_MODELS = [
  'MacBook Pro', 'MacBook Pro', 'MacBook Air', 'MacBook Air', 'Mac mini', 'Mac Studio', 'iMac',
  'MacBook Pro 16', 'MacBook Air 15',
]

const MANUAL_NOTES = [
  'Team license',
  'Gift for a beta tester',
  'Review key for a newsletter',
  'Replacement: buyer lost access to the PayPal mailbox',
  'Support: goodwill extension after an activation problem',
  'Internal test key',
]

const SUPPORT_NOTES = [
  'Asked for an invoice by email',
  'Moved to a new Mac, seat freed by support',
  'Reported the key email in spam',
]

function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
  }
}

/** The API's one date encoding: UTC, whole seconds, "2026-11-10T03:36:27Z" (api/README.md). */
export function toIso(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 19)}Z`
}

/** Same day of the month `months` later, clamped to the month's last day. UTC. */
export function addMonths(ms: number, months: number): number {
  const date = new Date(ms)
  const day = date.getUTCDate()
  date.setUTCDate(1)
  date.setUTCMonth(date.getUTCMonth() + months)
  const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate()
  date.setUTCDate(Math.min(day, lastDay))
  return date.getTime()
}

/** A fresh key from the browser's random source, for licenses created during the session. */
export function generateKey(): string {
  const bytes = new Uint8Array(20)
  crypto.getRandomValues(bytes)
  let body = ''
  for (let i = 0; i < bytes.length; i++) {
    // 256 is a multiple of 32, so the low 5 bits are uniform.
    body += KEY_ALPHABET[bytes[i] & 31]
    if (i % 5 === 4 && i < bytes.length - 1) {
      body += '-'
    }
  }
  return `NOS-${body}`
}

interface Person {
  first: string
  email: string
  payer_id: string | null
}

interface Device {
  id: string
  /** null for the few installs that sent no name. */
  name: string | null
  version: string | null
}

interface SeatDraft {
  device: Device
  activatedAt: number
  deactivatedAt: number | null
  lastSeenAt: number
  ip: string
}

type Draft<T extends { id: number }> = Omit<T, 'id'>

function byTime<T>(key: (row: T) => string): (a: T, b: T) => number {
  return (a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0)
}

export function buildSeed(now: number): MockDb {
  const rnd = mulberry32(20_261_110)
  const int = (min: number, max: number) => min + Math.floor(rnd() * (max - min + 1))
  const chance = (p: number) => rnd() < p
  const pick = <T,>(list: readonly T[]): T => list[Math.floor(rnd() * list.length)]
  const chars = (alphabet: string, length: number) => {
    let out = ''
    for (let i = 0; i < length; i++) {
      out += alphabet[Math.floor(rnd() * alphabet.length)]
    }
    return out
  }

  // Placeholders so the pages have numbers to show. The real prices are the owner's decision.
  const monthlyPrice = '3.00'
  const lifetimePrice = '15.00'
  const settings: Settings = {
    prices: { monthly: monthlyPrice, lifetime: lifetimePrice },
    trial_days: 7,
    transfer_limit: 2,
    renewal_buffer_hours: 24,
    download_url: 'https://example.com/downloads/NotchOS.dmg',
    app_version: '0.7.0',
    paypal_plan_id: null,
    mail: {
      mode: 'file',
      smtp_host: 'smtp.gmail.com',
      smtp_port: 465,
      smtp_secure: true,
      smtp_user: null,
      smtp_pass_set: false,
      mail_from: null,
      support_email: null,
    },
  }
  const bufferMs = settings.renewal_buffer_hours * HOUR

  const makeKey = () =>
    `NOS-${chars(KEY_ALPHABET, 5)}-${chars(KEY_ALPHABET, 5)}-${chars(KEY_ALPHABET, 5)}-${chars(KEY_ALPHABET, 5)}`

  const makeIp = () => {
    if (chance(0.12)) {
      return `2001:db8:${chars(HEX, 4)}:${chars(HEX, 4)}::${chars(HEX, 2)}`
    }
    return `${pick(['203.0.113', '198.51.100', '192.0.2'])}.${int(1, 254)}`
  }

  // device_name and app_version are optional in the app's requests, so a few rows have none.
  const makeVersion = (): string | null => {
    const r = rnd()
    return r < 0.57 ? '0.7.0' : r < 0.83 ? '0.6.2' : r < 0.94 ? '0.6.0' : r < 0.99 ? '0.5.1' : null
  }

  const makeDevice = (first: string): Device => {
    const model = pick(MAC_MODELS)
    const style = int(0, 9)
    const name =
      style <= 5
        ? `${first}’s ${model}`
        : style <= 7
          ? model
          : style === 8
            ? `${first}s-${model.replace(/\s+/g, '-')}`
            : `Work ${model}`
    return { id: chars(HEX, 64), name: chance(0.015) ? null : name, version: makeVersion() }
  }

  const makePerson = (withPayPal: boolean): Person => {
    const first = pick(FIRST_NAMES)
    const last = pick(LAST_NAMES)
    const f = first.toLowerCase()
    const l = last.toLowerCase()
    const style = int(0, 6)
    const local =
      style === 0
        ? `${f}.${l}`
        : style === 1
          ? `${f}${l}`
          : style === 2
            ? `${f[0]}${l}`
            : style === 3
              ? `${f}.${l}${int(2, 99)}`
              : style === 4
                ? `${f}_${l}`
                : style === 5
                  ? `${l}.${f}`
                  : `${f}${int(1980, 2004)}`
    return {
      first,
      email: `${local}@${pick(EMAIL_DOMAINS)}`,
      payer_id: withPayPal ? chars(PAYPAL_ALPHABET, 13) : null,
    }
  }

  const licenses: LicenseRow[] = []
  const activations: Draft<Activation>[] = []
  const events: Draft<LicenseEvent>[] = []
  const payments: Draft<PaymentRow>[] = []
  const audit: Draft<AuditRow>[] = []
  const trials: Trial[] = []

  const addAudit = (at: number, action: string, target: string, detail: string | null) => {
    audit.push({
      admin_id: MOCK_ADMIN_ID,
      action,
      target,
      detail,
      ip: chance(0.9) ? MOCK_ADMIN_IP : '198.51.100.23',
      created_at: toIso(Math.min(at, now)),
    })
  }

  // Ages, oldest first, with more licenses in recent months. The last few are forced into the
  // last hours so "sales today" is not empty whenever the mock is opened.
  const ages = Array.from({ length: LICENSE_COUNT }, () => 25 * MINUTE + rnd() ** 1.7 * 430 * DAY)
  const recent = [9.2 * HOUR, 6.4 * HOUR, 3.9 * HOUR, 1.7 * HOUR, 0.4 * HOUR]
  ages.sort((a, b) => b - a)
  ages.splice(ages.length - recent.length, recent.length, ...recent)
  ages.sort((a, b) => b - a)

  const payPalPeople: Person[] = []

  for (let index = 0; index < LICENSE_COUNT; index++) {
    const id = index + 1
    const age = ages[index]
    const ageDays = age / DAY
    const createdAt = now - age
    const target = `license:${id}`

    const manual = chance(0.07)
    let person: Person
    if (!manual && payPalPeople.length > 20 && chance(0.04)) {
      // The same PayPal account buys again: a second license for a second Mac.
      person = pick(payPalPeople)
    } else {
      person = makePerson(!manual)
      if (!manual) {
        payPalPeople.push(person)
      }
    }
    const homeIp = makeIp()

    const plan: LicensePlan = manual
      ? chance(0.65)
        ? 'lifetime'
        : 'monthly'
      : chance(0.44)
        ? 'lifetime'
        : 'monthly'

    let status: LicenseStatus = 'active'
    let periodEnd: number | null = null
    let expiresAt: number | null = null
    let autoRenew = false
    let subscriptionId: string | null = null
    let note: string | null = null
    let updatedAt = createdAt
    /** When a refund or an admin revoke ended this license, if it did. */
    let endedAt: number | null = null

    const unlucky = !manual && ageDays > 3 && chance(0.045)
    if (unlucky) {
      endedAt = Math.min(createdAt + (0.5 + rnd() * Math.min(20, ageDays - 1)) * DAY, now - HOUR)
    }

    if (manual) {
      note = pick(MANUAL_NOTES)
      if (plan === 'monthly') {
        periodEnd = createdAt + pick([30, 30, 90, 365]) * DAY
        expiresAt = periodEnd
      }
      addAudit(createdAt, 'license.create', target, `${plan}, ${person.email}`)
    } else if (plan === 'lifetime') {
      payments.push({
        license_id: id,
        kind: 'order',
        amount: lifetimePrice,
        created_at: toIso(createdAt),
      })
      if (endedAt !== null) {
        status = 'revoked'
        updatedAt = endedAt
        const byRefund = chance(0.75)
        if (byRefund) {
          note = 'Refunded in PayPal'
          payments.push({
            license_id: id,
            kind: 'refund',
            amount: lifetimePrice,
            created_at: toIso(endedAt),
          })
        } else {
          note = pick(['Chargeback filed', 'Key was shared publicly'])
          addAudit(endedAt, 'license.revoke', target, null)
        }
        events.push({
          license_id: id,
          device_id: null,
          type: 'revoke',
          detail: byRefund ? 'refund' : 'by admin',
          ip: null,
          created_at: toIso(endedAt),
        })
      }
    } else {
      subscriptionId = `I-${chars(PAYPAL_ALPHABET, 12)}`
      // Period k runs until addMonths(createdAt, k). `current` is the period that contains now.
      let current = 1
      while (addMonths(createdAt, current) <= now) {
        current++
      }
      let paidPeriods = current
      const fate = rnd()
      if (endedAt !== null) {
        // Refunded or revoked during the first period.
        paidPeriods = 1
      } else if (fate < 0.68 || (current === 1 && fate < 0.9)) {
        autoRenew = true
      } else if (fate >= 0.82 && current > 1) {
        // Stopped paying some periods ago: expired by now.
        paidPeriods = int(1, current - 1)
      }
      periodEnd = addMonths(createdAt, paidPeriods)
      expiresAt = autoRenew ? periodEnd + bufferMs : periodEnd

      payments.push({
        license_id: id,
        kind: 'subscription',
        amount: monthlyPrice,
        created_at: toIso(createdAt),
      })
      for (let period = 1; period < paidPeriods; period++) {
        const paidAt = addMonths(createdAt, period)
        payments.push({
          license_id: id,
          kind: 'subscription',
          amount: monthlyPrice,
          created_at: toIso(paidAt),
        })
        events.push({
          license_id: id,
          device_id: null,
          type: 'renew',
          detail: `paid through ${toIso(addMonths(createdAt, period + 1)).slice(0, 10)}`,
          ip: null,
          created_at: toIso(paidAt),
        })
        updatedAt = paidAt
      }

      if (endedAt !== null) {
        updatedAt = endedAt
        if (chance(0.6)) {
          // Refund of a monthly payment: the paid period ends at once, the license is not revoked.
          note = 'Refunded in PayPal'
          periodEnd = endedAt
          expiresAt = endedAt
          payments.push({
            license_id: id,
            kind: 'refund',
            amount: monthlyPrice,
            created_at: toIso(endedAt),
          })
        } else {
          status = 'revoked'
          note = pick(['Chargeback filed', 'Key was shared publicly'])
          addAudit(endedAt, 'license.revoke', target, null)
          events.push({
            license_id: id,
            device_id: null,
            type: 'revoke',
            detail: 'by admin',
            ip: null,
            created_at: toIso(endedAt),
          })
        }
      } else if (!autoRenew) {
        // The buyer cancelled in PayPal some time during the last paid period.
        const lastPeriodStart = addMonths(createdAt, paidPeriods - 1)
        updatedAt = Math.min(now, lastPeriodStart + rnd() * (periodEnd - lastPeriodStart))
      }
    }

    if (!manual && note === null && chance(0.03)) {
      note = pick(SUPPORT_NOTES)
    }

    let maxDevices = 1
    if (manual && chance(0.35)) {
      maxDevices = int(2, 5)
    } else if (!manual && endedAt === null && ageDays > 2 && chance(0.03)) {
      maxDevices = 2
      const raisedAt = createdAt + rnd() * (age - HOUR)
      addAudit(raisedAt, 'license.set_max_devices', target, '1 → 2')
      updatedAt = Math.max(updatedAt, raisedAt)
    }

    // ---- seats -------------------------------------------------------------------------
    const seats: SeatDraft[] = []
    let transfersUsed = 0
    // After a refund or revoke nothing more happens on this license.
    const lifeEnd = endedAt ?? now
    // A key can only be activated, or moved to another Mac, while it has not expired.
    const usableUntil = expiresAt === null ? lifeEnd : Math.min(lifeEnd, expiresAt)
    const activated = age < 30 * MINUTE ? chance(0.4) : chance(0.92)

    if (activated) {
      const firstAt = createdAt + Math.min((usableUntil - createdAt) * 0.9, (2 + rnd() ** 3 * 4000) * MINUTE)
      const firstDevice = makeDevice(person.first)
      seats.push({ device: firstDevice, activatedAt: firstAt, deactivatedAt: null, lastSeenAt: firstAt, ip: homeIp })
      events.push({
        license_id: id,
        device_id: firstDevice.id,
        type: 'activate',
        detail: firstDevice.name,
        ip: homeIp,
        created_at: toIso(firstAt),
      })

      // Moves to another Mac.
      const wanted = chance(0.8) ? 0 : chance(0.75) ? 1 : 2
      for (let move = 0; move < wanted; move++) {
        const previous = seats[seats.length - 1]
        const room = usableUntil - previous.activatedAt
        if (room < 20 * DAY) {
          break
        }
        const movedAt = previous.activatedAt + 5 * DAY + rnd() * (room - 10 * DAY)
        const nextDevice = makeDevice(person.first)
        previous.deactivatedAt = movedAt
        seats.push({ device: nextDevice, activatedAt: movedAt, deactivatedAt: null, lastSeenAt: movedAt, ip: homeIp })
        events.push({
          license_id: id,
          device_id: nextDevice.id,
          type: 'transfer',
          detail: `from ${previous.device.name ?? 'an unnamed Mac'}`,
          ip: homeIp,
          created_at: toIso(movedAt),
        })
        transfersUsed++
        updatedAt = Math.max(updatedAt, movedAt)
      }

      // A second Mac on licenses that allow more than one.
      if (maxDevices > 1 && chance(0.6)) {
        const base = seats[seats.length - 1].activatedAt
        const secondAt = Math.min(usableUntil, base + 10 * MINUTE + rnd() * (usableUntil - base) * 0.5)
        const secondDevice = makeDevice(pick(FIRST_NAMES))
        const secondIp = makeIp()
        seats.push({ device: secondDevice, activatedAt: secondAt, deactivatedAt: null, lastSeenAt: secondAt, ip: secondIp })
        events.push({
          license_id: id,
          device_id: secondDevice.id,
          type: 'activate',
          detail: secondDevice.name,
          ip: secondIp,
          created_at: toIso(secondAt),
        })
      }

      // A seat that was given up and not taken again.
      const lastSeat = seats[seats.length - 1]
      if (chance(0.05) && lifeEnd - lastSeat.activatedAt > 2 * DAY) {
        const freedAt = lastSeat.activatedAt + DAY + rnd() * (lifeEnd - lastSeat.activatedAt - DAY)
        const byAdmin = chance(0.4)
        lastSeat.deactivatedAt = freedAt
        events.push({
          license_id: id,
          device_id: lastSeat.device.id,
          type: 'deactivate',
          detail: byAdmin ? 'seat freed by admin' : 'deactivated in the app',
          ip: byAdmin ? null : lastSeat.ip,
          created_at: toIso(freedAt),
        })
        if (byAdmin) {
          addAudit(freedAt, 'license.free_seat', target, lastSeat.device.name ?? 'unnamed Mac')
        }
      }

      // Last seen and the refresh trail of every seat.
      for (const seat of seats) {
        const seatEnd = seat.deactivatedAt ?? lifeEnd
        // A refresh only succeeds while the license has not expired.
        const usableEnd = expiresAt !== null ? Math.min(seatEnd, expiresAt) : seatEnd
        let lastSeen: number
        if (usableEnd >= now) {
          lastSeen = now - (chance(0.88) ? rnd() ** 2 * 3 * DAY : (4 + rnd() * 40) * DAY)
        } else {
          lastSeen = usableEnd - rnd() * 2 * DAY
        }
        lastSeen = Math.min(now, Math.max(lastSeen, seat.activatedAt))
        if (lastSeen - seat.activatedAt <= HOUR) {
          // Too soon after activating for a refresh to have happened.
          lastSeen = seat.activatedAt
        }
        seat.lastSeenAt = lastSeen
        if (lastSeen > seat.activatedAt) {
          let at = lastSeen
          for (let n = 0; n < 14 && at > seat.activatedAt + HOUR; n++) {
            events.push({
              license_id: id,
              device_id: seat.device.id,
              type: 'refresh',
              detail: null,
              ip: chance(0.85) ? seat.ip : makeIp(),
              created_at: toIso(at),
            })
            at -= (0.6 + rnd() * 1.4) * DAY
          }
        }
      }

      // Refused attempts.
      if (chance(0.08)) {
        const at = firstAt + rnd() * (usableUntil - firstAt)
        events.push({
          license_id: id,
          device_id: chars(HEX, 64),
          type: 'deny',
          detail: 'already_active',
          ip: makeIp(),
          created_at: toIso(at),
        })
      }
      if (status === 'active' && expiresAt !== null && expiresAt <= now && chance(0.6)) {
        events.push({
          license_id: id,
          device_id: lastSeat.device.id,
          type: 'deny',
          detail: 'expired',
          ip: lastSeat.ip,
          created_at: toIso(Math.min(now, expiresAt + rnd() * 6 * HOUR)),
        })
      }
      if (status === 'revoked' && endedAt !== null && chance(0.7)) {
        events.push({
          license_id: id,
          device_id: lastSeat.device.id,
          type: 'deny',
          detail: 'revoked',
          ip: lastSeat.ip,
          created_at: toIso(Math.min(now, endedAt + rnd() * 2 * DAY)),
        })
      }

      // Some buyers started with the in-app trial on the same Mac.
      if (!manual && ageDays < 150 && chance(0.3)) {
        const startedAt = createdAt - (0.3 + rnd() * 8.5) * DAY
        trials.push({
          device_id: firstDevice.id,
          email: chance(0.7) ? person.email : null,
          started_at: toIso(startedAt),
          expires_at: toIso(startedAt + settings.trial_days * DAY),
          app_version: firstDevice.version,
          ip: homeIp,
        })
      }
    }

    for (const seat of seats) {
      activations.push({
        license_id: id,
        device_id: seat.device.id,
        device_name: seat.device.name,
        app_version: seat.device.version,
        activated_at: toIso(seat.activatedAt),
        last_seen_at: toIso(seat.lastSeenAt),
        deactivated_at: seat.deactivatedAt === null ? null : toIso(seat.deactivatedAt),
      })
    }

    const key = makeKey()
    licenses.push({
      id,
      key,
      key_hint: key.slice(-4),
      email: person.email,
      payer_id: person.payer_id,
      plan,
      status,
      max_devices: maxDevices,
      period_end: periodEnd === null ? null : toIso(periodEnd),
      expires_at: expiresAt === null ? null : toIso(expiresAt),
      auto_renew: autoRenew,
      paypal_subscription_id: subscriptionId,
      transfers_used: transfersUsed,
      source: manual ? 'manual' : 'paypal',
      note,
      created_at: toIso(createdAt),
      updated_at: toIso(Math.min(now, updatedAt)),
    })
  }

  // Trials that did not turn into a purchase, most of them recent.
  while (trials.length < TRIAL_COUNT) {
    const startedAt = now - (10 * MINUTE + rnd() ** 2.2 * 150 * DAY)
    trials.push({
      device_id: chars(HEX, 64),
      email: chance(0.45) ? `${chars('abcdefghijklmnopqrstuvwxyz', 6)}@${pick(EMAIL_DOMAINS)}` : null,
      started_at: toIso(startedAt),
      expires_at: toIso(startedAt + settings.trial_days * DAY),
      app_version: makeVersion(),
      ip: chance(0.02) ? null : makeIp(),
    })
  }
  trials.sort(byTime((trial) => trial.started_at))

  // The admin's own history: sign-ins, a few support actions, settings changes.
  for (let daysAgo = 60; daysAgo > 0; daysAgo -= int(1, 3)) {
    const at = now - daysAgo * DAY + rnd() * 10 * HOUR
    addAudit(at, 'login', 'session', null)
    if (chance(0.5)) {
      addAudit(at + (0.2 + rnd() * 3) * HOUR, 'logout', 'session', null)
    }
  }
  // Support actions happen after the license exists, within the last 60 days.
  const supportTime = (license: LicenseRow) =>
    Math.max(Date.parse(license.created_at) + MINUTE, now - rnd() * 60 * DAY)
  const usable = licenses.filter((license) => license.status === 'active')
  for (let n = 0; n < 8; n++) {
    const license = pick(usable)
    addAudit(supportTime(license), 'license.resend_key', `license:${license.id}`, license.email)
  }
  for (let n = 0; n < 5; n++) {
    const license = pick(usable)
    addAudit(supportTime(license), 'license.reveal_key', `license:${license.id}`, null)
  }
  addAudit(now - 52 * DAY, 'settings.update', 'settings', 'download_url: NotchOS-0.6.0.dmg → NotchOS-0.6.2.dmg')
  addAudit(now - 52 * DAY + MINUTE, 'settings.update', 'settings', 'app_version: 0.6.0 → 0.6.2')
  addAudit(now - 6 * DAY, 'settings.update', 'settings', 'app_version: 0.6.2 → 0.7.0; download_url: NotchOS-0.6.2.dmg → NotchOS-0.7.0.dmg')

  // Website trial leads (email before download).
  const trialLeads: TrialLead[] = []
  for (let n = 0; n < 48; n++) {
    const createdAt = now - (5 * MINUTE + rnd() ** 1.8 * 90 * DAY)
    const mailed = chance(0.92)
    const email = `${chars('abcdefghijklmnopqrstuvwxyz', 7)}${n}@${pick(EMAIL_DOMAINS)}`
    const withEmail = trials.filter((t) => t.email !== null)
    const matchedTrial = mailed && chance(0.35) && withEmail.length > 0 ? pick(withEmail) : null
    trialLeads.push({
      id: n + 1,
      email: matchedTrial?.email ?? email,
      status: matchedTrial ? 'converted' : mailed ? 'mailed' : 'new',
      download_sent_at: mailed ? toIso(createdAt + int(10, 120) * 1000) : null,
      resend_count: mailed && chance(0.2) ? int(1, 3) : 0,
      converted_trial_device_id: matchedTrial?.device_id ?? null,
      converted_license_id: null,
      created_at: toIso(createdAt),
    })
  }
  trialLeads.sort(byTime((row) => row.created_at))

  // Seat moves from transfer / deactivate events (support report).
  const seatMoves: SeatMove[] = []
  let seatMoveId = 1
  for (const event of events) {
    if (event.license_id === null) continue
    const license = licenses.find((row) => row.id === event.license_id)
    if (license === undefined) continue
    if (event.type === 'transfer') {
      seatMoves.push({
        id: seatMoveId++,
        license_id: license.id,
        email: license.email,
        key_hint: license.key_hint,
        from_device_id: chars(HEX, 64),
        from_device_name: `${pick(FIRST_NAMES)}'s MacBook Pro`,
        to_device_id: event.device_id,
        to_device_name: 'This Mac',
        reason: 'user_transfer',
        transfers_used_after: Math.min(license.transfers_used || 1, settings.transfer_limit),
        transfers_left_after: Math.max(0, settings.transfer_limit - (license.transfers_used || 1)),
        actor: 'user',
        detail: event.detail,
        created_at: event.created_at,
      })
    } else if (event.type === 'deactivate' && event.detail?.includes('by this Mac')) {
      seatMoves.push({
        id: seatMoveId++,
        license_id: license.id,
        email: license.email,
        key_hint: license.key_hint,
        from_device_id: event.device_id,
        from_device_name: null,
        to_device_id: null,
        to_device_name: null,
        reason: 'user_deactivate',
        transfers_used_after: license.transfers_used,
        transfers_left_after: Math.max(0, settings.transfer_limit - license.transfers_used),
        actor: 'user',
        detail: event.detail,
        created_at: event.created_at,
      })
    } else if (event.type === 'deactivate' && event.detail?.includes('admin')) {
      seatMoves.push({
        id: seatMoveId++,
        license_id: license.id,
        email: license.email,
        key_hint: license.key_hint,
        from_device_id: event.device_id,
        from_device_name: null,
        to_device_id: null,
        to_device_name: null,
        reason: 'admin_free_seat',
        transfers_used_after: license.transfers_used,
        transfers_left_after: Math.max(0, settings.transfer_limit - license.transfers_used),
        actor: 'admin',
        detail: event.detail,
        created_at: event.created_at,
      })
    }
  }
  seatMoves.sort(byTime((row) => row.created_at))

  // Ids follow time, as auto-increment ids would.
  activations.sort(byTime((row) => row.activated_at))
  events.sort(byTime((row) => row.created_at))
  payments.sort(byTime((row) => row.created_at))
  audit.sort(byTime((row) => row.created_at))

  return {
    admin: { id: MOCK_ADMIN_ID, username: DEFAULT_ADMIN_USERNAME },
    licenses,
    activations: activations.map((row, i) => ({ id: i + 1, ...row })),
    events: events.map((row, i) => ({ id: i + 1, ...row })),
    trials,
    trialLeads: trialLeads.map((row, i) => ({ ...row, id: i + 1 })),
    seatMoves: seatMoves.map((row, i) => ({ ...row, id: i + 1 })),
    payments: payments.map((row, i) => ({ id: i + 1, ...row })),
    audit: audit.map((row, i) => ({ id: i + 1, ...row })),
    settings,
    smtpPass: null,
    attention: { failed_emails: 2, unprocessed_webhooks: 0, open_disputes: 1 },
    nextId: {
      license: licenses.length + 1,
      activation: activations.length + 1,
      event: events.length + 1,
      audit: audit.length + 1,
      seatMove: seatMoves.length + 1,
      trialLead: trialLeads.length + 1,
    },
  }
}
