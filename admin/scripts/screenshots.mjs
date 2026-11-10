#!/usr/bin/env node
/**
 * Drives the admin in headless Chrome: signs in, clicks through every page and every
 * license action, checks what it sees, and saves a screenshot of each page and state
 * into admin/screenshots/.
 *
 *   npm run build && npm run screenshots        the built app, served by `vite preview`
 *   npm run screenshots -- --dev                the dev server instead (React's development
 *                                               warnings are on there), no screenshots
 *   npm run screenshots -- --dev --shots        the dev server, with screenshots
 *
 * The script starts the server on 127.0.0.1:4311 itself and stops it when it is done.
 * It refuses to run if something is already listening on that port.
 * Chrome is the one installed on this Mac (override with CHROME_PATH), started headless with
 * a temporary profile that is deleted afterwards. Nothing is downloaded.
 * Exit code 0 means every check passed and the browser console stayed clean.
 *
 * The mock data lives in the page's memory, so a full page load starts again from the seed.
 * Part C below is therefore one unbroken visit: it only moves through links and buttons.
 */

import { spawn } from 'node:child_process'
import { access, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import net from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { setTimeout as sleep } from 'node:timers/promises'

import puppeteer from 'puppeteer-core'

const ADMIN_DIR = path.resolve(import.meta.dirname, '..')
const OUT_DIR = path.join(ADMIN_DIR, 'screenshots')
const HOST = '127.0.0.1'
const PORT = 4311
const ORIGIN = `http://${HOST}:${PORT}`
const CHROME =
  process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const SESSION_STORAGE_KEY = 'notchos-admin.mock-session'
const KEY_PATTERN = /^NOS-[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}$/

const DEV = process.argv.includes('--dev')
const SHOTS = !DEV || process.argv.includes('--shots')

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const fileExists = (file) =>
  access(file).then(
    () => true,
    () => false,
  )

function portIsOpen() {
  return new Promise((resolve) => {
    const socket = net.connect({ host: HOST, port: PORT })
    socket.once('connect', () => {
      socket.destroy()
      resolve(true)
    })
    socket.once('error', () => resolve(false))
  })
}

async function startServer() {
  if (await portIsOpen()) {
    throw new Error(`Something is already listening on ${ORIGIN}. Stop it first; this script starts its own server.`)
  }
  if (!DEV && !(await fileExists(path.join(ADMIN_DIR, 'dist', 'index.html')))) {
    throw new Error('There is no build to serve. Run `npm run build` first, or use `-- --dev`.')
  }
  const vite = path.join(ADMIN_DIR, 'node_modules', 'vite', 'bin', 'vite.js')
  const child = spawn(process.execPath, DEV ? [vite] : [vite, 'preview'], {
    cwd: ADMIN_DIR,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.on('data', (chunk) => (output += chunk))
  child.stderr.on('data', (chunk) => (output += chunk))
  const exited = new Promise((resolve) => child.once('exit', resolve))

  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) {
      throw new Error(`The server stopped before it was ready:\n${output}`)
    }
    if (await portIsOpen()) {
      return {
        async stop() {
          child.kill('SIGTERM')
          await Promise.race([exited, sleep(5000)])
          if (child.exitCode === null && child.signalCode === null) {
            child.kill('SIGKILL')
            await exited
          }
        },
      }
    }
    await sleep(150)
  }
  child.kill('SIGKILL')
  throw new Error(`The server did not open ${ORIGIN} in time:\n${output}`)
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

const results = []
let currentStep = ''

function check(name, passed, detail = '') {
  results.push({ step: currentStep, name, passed })
  console.log(`  ${passed ? 'ok  ' : 'FAIL'} ${name}${detail === '' ? '' : `  [${detail}]`}`)
}

function step(title) {
  currentStep = title
  console.log(`\n${title}`)
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

async function main() {
  console.log(`Admin ${DEV ? 'dev server' : 'production build (vite preview)'} at ${ORIGIN}`)
  console.log(`Chrome: ${CHROME}`)
  const server = await startServer()
  const profileDir = await mkdtemp(path.join(tmpdir(), 'notchos-admin-chrome-'))
  let browser
  let page

  try {
    if (SHOTS) {
      await rm(OUT_DIR, { recursive: true, force: true })
      await mkdir(OUT_DIR, { recursive: true })
    }

    browser = await puppeteer.launch({
      executablePath: CHROME,
      headless: true,
      // Talk to Chrome over a pipe, so no debugging port is opened.
      pipe: true,
      userDataDir: profileDir,
      defaultViewport: { width: 1280, height: 800, deviceScaleFactor: 2 },
      args: [
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-extensions',
        '--disable-sync',
        '--disable-background-networking',
        '--disable-component-update',
        '--disable-default-apps',
        '--mute-audio',
        // Never touch the macOS Keychain (no permission prompt).
        '--use-mock-keychain',
        '--password-store=basic',
      ],
    })
    // Lets the Copy buttons write to the clipboard of this temporary profile, and the script read it.
    await browser
      .defaultBrowserContext()
      .overridePermissions(ORIGIN, ['clipboard-read', 'clipboard-write', 'clipboard-sanitized-write'])
      .catch((error) => console.log(`  note clipboard permission could not be set: ${error.message}`))
    page = await browser.newPage()
    page.setDefaultTimeout(8000)

    // Everything the browser complains about ends the run as a failure.
    const consoleProblems = []
    const foreignRequests = []
    const apiRequests = []
    page.on('console', (message) => {
      if (message.type() === 'error' || message.type() === 'warn') {
        consoleProblems.push(`console.${message.type()}: ${message.text()}`)
      }
    })
    page.on('pageerror', (error) => consoleProblems.push(`uncaught: ${error.message}`))
    page.on('requestfailed', (request) => {
      consoleProblems.push(`request failed: ${request.url()} (${request.failure()?.errorText ?? 'unknown'})`)
    })
    page.on('request', (request) => {
      const url = request.url()
      if (url.startsWith('data:') || url.startsWith('blob:')) {
        return
      }
      if (!url.startsWith(`${ORIGIN}/`)) {
        foreignRequests.push(url)
      } else if (new URL(url).pathname.startsWith('/api')) {
        // The mock answers inside the page: nothing may be sent to the API in this phase.
        apiRequests.push(url)
      }
    })

    // ---- helpers -------------------------------------------------------------------------

    const location = () => page.evaluate(() => window.location.pathname + window.location.search)
    const text = (selector) => page.$eval(selector, (element) => element.textContent?.trim() ?? '')
    const count = (selector) => page.$$eval(selector, (elements) => elements.length)
    const exists = async (selector) => (await page.$(selector)) !== null
    const value = (selector) => page.$eval(selector, (input) => input.value)

    /** A full page load. This also starts the mock data again from the seed. */
    async function load(pathAndQuery) {
      await page.goto(ORIGIN + pathAndQuery, { waitUntil: 'load' })
    }

    /** Waits until the address is `expected` (path plus query). */
    async function waitForLocation(expected) {
      try {
        await page.waitForFunction(
          (wanted) => window.location.pathname + window.location.search === wanted,
          {},
          expected,
        )
        return true
      } catch {
        return false
      }
    }

    /** Waits until `predicate` (run in the page) returns true. Resolves false if it never does. */
    const eventually = (predicate, ...args) =>
      page.waitForFunction(predicate, {}, ...args).then(
        () => true,
        () => false,
      )

    /** Waits until no loading placeholder is on screen. */
    async function settled() {
      // First give React a moment to draw what follows a click or an address change.
      await page.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 40)))),
      )
      await page.waitForFunction(
        () =>
          document.querySelector('[data-slot="skeleton"]') === null &&
          document.querySelector('[aria-busy="true"]') === null,
      )
    }

    /**
     * Waits until the table has loaded and every row has the wanted data attributes,
     * for example allRows('tr[data-license-id]', { licenseState: 'revoked' }).
     */
    const allRows = (selector, wanted) =>
      eventually(
        (rowSelector, attributes) => {
          if (document.querySelector('[aria-busy="true"], [data-slot="skeleton"]') !== null) {
            return false
          }
          const rows = [...document.querySelectorAll(rowSelector)]
          return (
            rows.length > 0 &&
            rows.every((row) => Object.entries(attributes).every(([name, value]) => row.dataset[name] === value))
          )
        },
        selector,
        wanted,
      )

    const rangeIs = (wanted) =>
      page
        .waitForFunction(
          (expected) => document.querySelector('[data-testid="pager-range"]')?.textContent === expected,
          {},
          wanted,
        )
        .then(
          () => true,
          () => false,
        )

    /** Waits until a selector is on screen and returns its handle. */
    const visible = (selector) => page.waitForSelector(selector, { visible: true })

    const roleSelector = (role, name) => `::-p-aria([name="${name}"][role="${role}"])`

    async function clickRole(role, name) {
      const handle = await visible(roleSelector(role, name))
      // A button that is disabled while a call is in flight becomes clickable again shortly.
      await page.waitForFunction((element) => !element.disabled, {}, handle)
      await handle.click()
    }

    /** Replaces what is in a text field by typing, as a person would. */
    async function fill(selector, text) {
      const handle = await visible(selector)
      await handle.click()
      await handle.evaluate((field) => field.select())
      await page.keyboard.press('Backspace')
      if (text !== '') {
        await handle.type(text)
      }
    }

    /** Picks an option of a Select by the trigger's accessible name. */
    async function choose(triggerName, optionName) {
      await clickRole('combobox', triggerName)
      await clickRole('option', optionName)
      await page.waitForFunction(() => document.querySelector('[role="listbox"]') === null)
    }

    async function waitForToast(fragment) {
      try {
        await page.waitForFunction(
          (wanted) =>
            [...document.querySelectorAll('[data-sonner-toast]')].some((toast) =>
              (toast.textContent ?? '').includes(wanted),
            ),
          {},
          fragment,
        )
        return true
      } catch {
        return false
      }
    }

    /** Waits until earlier toasts are gone, so they are not in the next screenshot. */
    async function toastsGone() {
      await page.waitForFunction(() => document.querySelector('[data-sonner-toast]') === null, { timeout: 15000 })
    }

    async function confirmDialog(buttonName) {
      await visible('[role="alertdialog"]')
      await clickRole('button', buttonName)
      await page.waitForFunction(() => document.querySelector('[role="alertdialog"]') === null)
    }

    async function dialogClosed() {
      await page.waitForFunction(() => document.querySelector('[role="dialog"]') === null)
    }

    /**
     * A screenshot of the whole page, or with `fullPage: false` of the window as it is
     * (for dialogs and toasts, which are placed relative to the window).
     * For a whole page the window is made as tall as the page first, so the fixed sidebar
     * and the rest of the frame are drawn as they are, not cut off after the first screen.
     */
    async function shot(name, { fullPage = true } = {}) {
      if (!SHOTS) {
        return
      }
      // Let web fonts and enter animations finish, and move the pointer off the content.
      await page.evaluate(() => document.fonts.ready)
      await page.mouse.move(640, 2)
      await sleep(400)
      const file = path.join(OUT_DIR, `${name}.png`)
      const viewport = page.viewport()
      const pageHeight = await page.evaluate(() => document.documentElement.scrollHeight)
      if (fullPage && pageHeight > viewport.height) {
        await page.setViewport({ ...viewport, height: Math.min(pageHeight, 8000) })
        await sleep(300)
        await page.screenshot({ path: file })
        await page.setViewport(viewport)
        await sleep(150)
      } else {
        await page.screenshot({ path: file })
      }
      console.log(`  shot ${name}.png`)
    }

    async function signIn(username = 'sagar') {
      await fill('#login-username', username)
      await fill('#login-password', 'any password works on mock data')
      await fill('#login-code', '123456')
      await clickRole('button', 'Sign in')
    }

    /** Moves to a page through its sidebar link, without a page load. */
    async function sidebar(name, expectedPath) {
      await clickRole('link', name)
      await waitForLocation(expectedPath)
    }

    const licenseRows = () =>
      page.$$eval('tr[data-license-id]', (rows) =>
        rows.map((row) => ({
          id: Number(row.dataset.licenseId),
          state: row.dataset.licenseState,
          plan: row.dataset.licensePlan,
          seatsUsed: Number(row.dataset.seatsUsed),
          email: row.querySelector('a')?.textContent?.trim() ?? '',
          text: row.textContent ?? '',
        })),
      )

    const auditRows = () =>
      page.$$eval('tr[data-audit-action]', (rows) =>
        rows.map((row) => ({
          action: row.dataset.auditAction,
          target: row.dataset.auditTarget,
          detail: row.querySelector('td:nth-child(5)')?.textContent?.trim() ?? '',
        })),
      )

    /** Waits until the list under the pager has loaded and counts exactly `total` rows in all. */
    const totalIs = (total, noun) =>
      eventually(
        (wanted, word) =>
          document.querySelector('[aria-busy="true"]') === null &&
          new RegExp(`(^| of )${wanted} ${word}$`).test(document.querySelector('[data-testid="pager-range"]')?.textContent ?? ''),
        total,
        noun,
      )

    /** At this window width nothing needs sideways scrolling: not the page, not a table. */
    const fitsWidth = () =>
      page.evaluate(
        () =>
          document.documentElement.scrollWidth <= window.innerWidth &&
          [...document.querySelectorAll('[data-slot="table-container"]')].every(
            (container) => container.scrollWidth <= container.clientWidth,
          ),
      )

    const licenseState = () => page.$eval('[data-testid="license-badges"]', (element) => element.dataset.licenseState)
    const counter = async (testId) => Number((await text(`[data-testid="${testId}"]`)).replace(/[^\d]/g, ''))

    // =====================================================================================
    // A. Signed out, signing in
    // =====================================================================================

    step('A1. Signed out: any page goes to the login screen')
    await load('/licenses?plan=monthly')
    check('redirected to /login with the page remembered', await waitForLocation('/login?next=%2Flicenses%3Fplan%3Dmonthly'), await location())
    await visible('#login-username')
    check('login says it runs on mock data', (await text('[data-testid="mock-notice"]')).includes('Running on mock data'))
    check('tab title', (await page.title()) === 'Sign in · NotchOS Admin', await page.title())
    await shot('01-login')

    await clickRole('button', 'Sign in')
    await visible('[data-slot="field-error"]')
    check('empty form shows three field messages', (await count('[data-slot="field-error"]')) === 3)
    await shot('02-login-empty-fields')

    await load('/login?mock=login-error')
    await signIn()
    await visible('[data-testid="login-error"]')
    check('refused sign-in shows the server message', (await text('[data-testid="login-error"]')).includes('Wrong username, password or code.'))
    check('refused sign-in clears the code', (await value('#login-code')) === '')
    await shot('03-login-refused')

    await load('/login?mock=login-rate-limited')
    await signIn()
    await visible('[data-testid="login-error"]')
    check('too many attempts: says how long to wait', (await text('[data-testid="login-error"]')).includes('Too many sign-in attempts. Try again in 14 minutes.'), await text('[data-testid="login-error"]'))

    step('A2. Sign in, come back to the page that was asked for, stay signed in on reload')
    await load('/login?next=%2Flicenses%3Fplan%3Dmonthly')
    await signIn()
    check('after signing in: back on /licenses?plan=monthly', await waitForLocation('/licenses?plan=monthly'), await location())
    await visible('tr[data-license-id]')
    await settled()
    check('the filter from the address is applied', (await licenseRows()).every((row) => row.plan === 'monthly'))
    await page.reload({ waitUntil: 'load' })
    await visible('tr[data-license-id]')
    check('reload stays signed in on the same page', (await location()) === '/licenses?plan=monthly')
    await load('/login')
    check('/login while signed in goes to the app', await waitForLocation('/'))

    // =====================================================================================
    // B. Looking only: lists, paging, filters, and the empty / error / loading states
    // =====================================================================================

    step('B1. Licenses: default list and paging')
    await load('/licenses')
    await visible('tr[data-license-id]')
    await settled()
    check('50 rows, newest first', (await count('tr[data-license-id]')) === 50 && (await licenseRows())[0].id === 342)
    check('range text', await rangeIs('1–50 of 342 licenses'), await text('[data-testid="pager-range"]'))
    check('lists show only the last 4 characters of a key', !(await licenseRows()).some((row) => /NOS-[A-Z2-9]{5}/.test(row.text)))
    check('page heading and tab title', (await text('header h1')) === 'Licenses' && (await page.title()) === 'Licenses · NotchOS Admin')
    check('fits 1280 px without sideways scrolling', await fitsWidth())
    await shot('10-licenses')

    // Times are shown in local time; the stored UTC value is one hover away.
    await (await visible('tr[data-license-id] td:last-child time')).hover()
    const utcShown = await eventually(() => /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC/.test(document.querySelector('[data-slot="tooltip-content"]')?.textContent ?? ''))
    check('hovering a time shows its UTC value', utcShown, utcShown ? await text('[data-slot="tooltip-content"]') : '')
    if (SHOTS && utcShown) {
      await sleep(250)
      await page.screenshot({ path: path.join(OUT_DIR, '18-utc-on-hover.png'), clip: { x: 640, y: 40, width: 640, height: 220 } })
      console.log('  shot 18-utc-on-hover.png')
    }
    await page.mouse.move(640, 2)

    await clickRole('button', 'Next page')
    check('next page is in the address', await waitForLocation('/licenses?page=2'))
    // The range text follows the address at once; the rows follow when they have loaded.
    const pageShows = async (range) => (await rangeIs(range)) && (await settled(), true)
    check('page 2 shows rows 51 to 100', (await pageShows('51–100 of 342 licenses')) && (await licenseRows())[0].id === 292)
    await page.goBack()
    check('Back returns to page 1', (await waitForLocation('/licenses')) && (await pageShows('1–50 of 342 licenses')) && (await licenseRows())[0].id === 342)
    await clickRole('button', 'Last page')
    await waitForLocation('/licenses?page=7')
    check('last page has the remaining 42 rows', (await pageShows('301–342 of 342 licenses')) && (await count('tr[data-license-id]')) === 42 && (await licenseRows()).at(-1).id === 1)
    await shot('11-licenses-last-page')
    await choose('Rows per page', '25')
    await waitForLocation('/licenses?page_size=25')
    check('25 rows per page starts again at page 1', (await pageShows('1–25 of 342 licenses')) && (await count('tr[data-license-id]')) === 25)
    await load('/licenses?page=99')
    check('a page past the end falls back to the last page', await waitForLocation('/licenses?page=7'), await location())

    step('B2. Licenses: filters and search')
    // What the dashboard counts as active monthly, to compare the filtered list with.
    await load('/')
    await visible('[data-testid="active-monthly"]')
    await settled()
    const activeMonthly = await counter('active-monthly')
    await sidebar('Licenses', '/licenses')
    await visible('tr[data-license-id]')
    await choose('Plan', 'Monthly')
    await choose('Status', 'Active')
    check('plan and status are in the address', await waitForLocation('/licenses?plan=monthly&state=active'), await location())
    check(
      'plan + status: as many licenses as the dashboard counts, every row monthly and active',
      (await totalIs(activeMonthly, 'licenses')) && (await allRows('tr[data-license-id]', { licensePlan: 'monthly', licenseState: 'active' })),
      await text('[data-testid="pager-range"]'),
    )
    await (await visible('[data-testid="filter-expiring"]')).click()
    check('expiring soon is in the address', await waitForLocation('/licenses?plan=monthly&state=active&expiring=1'), await location())
    const expiringOnly = await eventually((all) => {
      if (document.querySelector('[aria-busy="true"]') !== null) {
        return false
      }
      const total = Number(document.querySelector('[data-testid="pager-range"]')?.textContent?.match(/of (\d+) /)?.[1])
      const rows = [...document.querySelectorAll('tr[data-license-id]')]
      const soon = Date.now() + 7 * 86_400_000
      return (
        total > 0 &&
        total < all &&
        rows.length === Math.min(total, 50) &&
        rows.every((row) => {
          const expires = Date.parse(row.dataset.expiresAt ?? '')
          return row.dataset.licenseState === 'active' && expires > Date.now() - 60_000 && expires <= soon
        })
      )
    }, activeMonthly)
    check('expiring soon: fewer rows, each one active and expiring within 7 days', expiringOnly, await text('[data-testid="pager-range"]'))
    await shot('12-licenses-filtered')
    await clickRole('button', 'Clear filters')
    check('Clear filters empties the address and brings every license back', (await waitForLocation('/licenses')) && (await pageShows('1–50 of 342 licenses')))

    const sample = (await licenseRows())[5]
    /** Waits until the list has loaded for this search: fewer than a full page, with the sample in it. */
    const searchFinds = (query) =>
      eventually(
        (wanted, id) =>
          new URLSearchParams(window.location.search).get('q') === wanted &&
          document.querySelector('[aria-busy="true"]') === null &&
          document.querySelectorAll('tr[data-license-id]').length < 50 &&
          document.querySelector(`tr[data-license-id="${id}"]`) !== null,
        query,
        sample.id,
      )
    const emailPart = sample.email.slice(0, 8)
    await fill('[role="searchbox"]', emailPart)
    const byEmail = (await searchFinds(emailPart)) ? await licenseRows() : []
    check('search by part of the email', byEmail.length > 0 && byEmail.every((row) => row.email.toLowerCase().includes(emailPart.toLowerCase())), `${byEmail.length} row(s) for "${emailPart}"`)
    const keyEnding = sample.text.match(/····([A-Z2-9]{4})/)?.[1] ?? ''
    await fill('[role="searchbox"]', keyEnding)
    check('search by the key ending', await searchFinds(keyEnding), `${await count('tr[data-license-id]')} row(s) for "${keyEnding}"`)
    await shot('13-licenses-search')
    await clickRole('button', 'Clear search')
    check('clearing the search empties the address', await waitForLocation('/licenses'))

    step('B3. Licenses: empty, no match, error, loading')
    await load('/licenses?mock=empty')
    await visible('[data-slot="empty"]')
    check('empty state', (await text('[data-slot="empty-title"]')) === 'No licenses yet')
    await shot('14-licenses-empty')
    await load('/licenses?q=zzzz-no-such-license')
    await visible('[data-slot="empty"]')
    check('no-match state', (await text('[data-slot="empty-title"]')) === 'No licenses match')
    await shot('15-licenses-no-match')
    await load('/licenses?mock=error')
    await visible('[data-slot="alert"]')
    check('error state with Retry', (await text('[data-slot="alert-title"]')) === 'Could not load licenses' && (await exists('[data-slot="alert-action"] button')))
    await shot('16-licenses-error')
    await load('/licenses?mock=slow')
    await visible('[data-slot="skeleton"]')
    check('loading state shows placeholder rows', (await count('[data-slot="skeleton"]')) > 20)
    await shot('17-licenses-loading')

    step('B4. Other pages: empty and error states, addresses without a page')
    await load('/?mock=empty')
    await visible('[data-testid="sales-today"]')
    check('dashboard with nothing to count', (await counter('active-monthly')) === 0)
    await shot('05-dashboard-empty')
    await load('/?mock=error')
    await visible('[data-slot="alert"]')
    check('dashboard error state', (await text('[data-slot="alert-title"]')) === 'Could not load the dashboard')
    await shot('06-dashboard-error')
    await load('/trials?mock=empty')
    await visible('[data-slot="empty"]')
    check('trials empty state', (await text('[data-slot="empty-title"]')) === 'No trials yet')
    await shot('41-trials-empty')
    await load('/audit?mock=empty')
    await visible('[data-slot="empty"]')
    check('audit log empty state', (await text('[data-slot="empty-title"]')) === 'Nothing has been logged yet')
    await load('/settings?mock=error')
    await visible('[data-slot="alert"]')
    check('settings error state', (await text('[data-slot="alert-title"]')) === 'Could not load the settings')
    await load('/settings?mock=empty')
    await visible('#settings-trial-days')
    check('settings on a fresh install: prices, link and version are not set, the three defaults are', (await value('#settings-price-monthly')) === '' && (await value('#settings-price-lifetime')) === '' && (await value('#settings-download-url')) === '' && (await value('#settings-app-version')) === '' && (await value('#settings-trial-days')) === '7' && (await value('#settings-transfer-limit')) === '2' && (await value('#settings-renewal-buffer')) === '24')
    await shot('52-settings-not-set')
    await load('/licenses/999999')
    await visible('[data-slot="empty"]')
    check('unknown license id', (await text('[data-slot="empty-title"]')) === 'License not found')
    await shot('28-license-not-found')
    await load('/licenses/not-a-number')
    await visible('[data-slot="empty"]')
    check('license id that is not a number', (await text('[data-slot="empty-title"]')) === 'License not found')
    await load('/payments')
    await visible('[data-slot="empty"]')
    check('Payments has no page yet', (await text('[data-slot="empty-title"]')) === 'There is no page at this address')
    await shot('70-no-such-page')

    // =====================================================================================
    // C. One unbroken visit: every action, and what it leaves behind
    // =====================================================================================

    step('C1. Dashboard')
    await load('/')
    await visible('[data-testid="sales-today"]')
    await settled()
    const before = {
      monthly: await counter('active-monthly'),
      lifetime: await counter('active-lifetime'),
      subscribers: await counter('monthly-subscribers'),
      onTrial: await counter('trials-active'),
    }
    check('counters are numbers', before.monthly > 0 && before.lifetime > 0 && before.subscribers > 0, JSON.stringify(before))
    check('top bar shows the mock badge and the admin', (await text('[data-testid="mock-badge"]')) === 'Mock data' && (await text('[data-testid="user-menu"]')) === 'sagar')
    check('page heading', (await text('header h1')) === 'Dashboard')
    check('Payments, Webhooks, Emails are listed but are not links', (await count('[data-nav-unavailable]')) === 3 && !(await exists('a[href="/payments"], a[href="/webhooks"], a[href="/emails"]')))
    await shot('04-dashboard')

    step('C2. License detail: an active license with a seat in use')
    await sidebar('Licenses', '/licenses')
    await visible('tr[data-license-id]')
    await choose('Plan', 'Monthly')
    await choose('Status', 'Active')
    await waitForLocation('/licenses?plan=monthly&state=active')
    await totalIs(before.monthly, 'licenses')
    await allRows('tr[data-license-id]', { licensePlan: 'monthly', licenseState: 'active' })
    // A PayPal one (it has a payer and a subscription id), the oldest on the first page:
    // it has renewals and a refresh trail to show.
    const target = (await licenseRows())
      .filter((row) => row.seatsUsed === 1 && row.text.includes('1 / 1') && !row.text.includes('Manual'))
      .at(-1)
    check('found an active monthly license with its seat in use', target !== undefined, target ? `#${target.id} ${target.email}` : '')
    // Click the row itself (its Status cell), not the email link.
    await (await visible(`tr[data-license-id="${target.id}"] td:nth-child(4)`)).click()
    check('a click on the row opens the license', await waitForLocation(`/licenses/${target.id}`))
    await visible('[data-testid="license-email"]')
    check('heading and tab title', (await text('header h1')) === `License #${target.id}` && (await page.title()) === `License #${target.id} · NotchOS Admin`)
    check('state is active, key is masked', (await licenseState()) === 'active' && (await text('[data-testid="license-key"]')).startsWith('NOS-•••••-•••••-•••••-•'))
    check('seat summary', (await text('[data-testid="seats-summary"]')).startsWith('1 of 1 in use'))
    check('fits 1280 px without sideways scrolling', await fitsWidth())
    const payerId = await text('[data-testid="payer-id"]')
    const subscriptionId = await text('[data-testid="subscription-id"]')
    await shot('20-license-active-seat-in-use')

    const hasRefreshes = (await count('tr[data-event-type="refresh"]')) > 0
    await clickRole('radio', 'Without refreshes')
    check('event history can hide refreshes', hasRefreshes && (await eventually(() => document.querySelector('tr[data-event-type="refresh"]') === null)), `${await count('tr[data-event-type]')} other events`)
    await clickRole('radio', 'All')
    await visible('tr[data-event-type="refresh"]')

    step('C3. Confirm dialog and reveal key')
    await clickRole('button', 'Revoke')
    await visible('[role="alertdialog"]')
    check('Revoke asks first', (await text('[data-slot="alert-dialog-title"]')) === 'Revoke this license?')
    await shot('21-confirm-dialog', { fullPage: false })
    await clickRole('button', 'Cancel')
    await page.waitForFunction(() => document.querySelector('[role="alertdialog"]') === null)
    check('Cancel changes nothing', (await licenseState()) === 'active')

    await clickRole('button', 'Reveal key')
    await visible('[role="alertdialog"]')
    check('Reveal key asks first', (await text('[data-slot="alert-dialog-title"]')) === 'Reveal the complete key?')
    await confirmDialog('Reveal key')
    await page.waitForSelector('[data-testid="license-key"][data-revealed="true"]')
    const revealedKey = await text('[data-testid="license-key"]')
    check('the complete key is shown after confirming', KEY_PATTERN.test(revealedKey))
    await shot('22-key-revealed')
    await clickRole('button', 'Copy')
    check('Copy says so', await eventually(() => [...document.querySelectorAll('button')].some((button) => button.textContent?.trim() === 'Copied')))
    const clipboard = await page.evaluate(() => navigator.clipboard.readText()).catch((error) => `unreadable: ${error.message}`)
    check('the clipboard holds the key', clipboard === revealedKey, clipboard === revealedKey ? '' : clipboard.slice(0, 60))
    await clickRole('button', 'Hide key')
    await page.waitForSelector('[data-testid="license-key"][data-revealed="false"]')
    check('Hide key masks it again', (await text('[data-testid="license-key"]')).startsWith('NOS-•••••'))

    step('C4. Every license action changes the page and shows a toast')
    await clickRole('button', 'Extend')
    await visible('[role="dialog"]')
    await clickRole('radio', '90 d')
    await shot('23-extend-dialog', { fullPage: false })
    await clickRole('button', 'Extend')
    check('extend: toast', await waitForToast('Extended. Paid through'))
    await dialogClosed()
    await shot('24-toast', { fullPage: false })

    await clickRole('button', 'Allow more Macs')
    await fill('#max-devices', '3')
    await clickRole('button', 'Save')
    check('allow more Macs: toast', await waitForToast('This key now allows 3 Macs.'))
    await dialogClosed()
    check('allow more Macs: seat summary', (await text('[data-testid="seats-summary"]')).startsWith('1 of 3 in use'))

    await clickRole('button', 'Change email')
    await fill('#license-email', 'moved.address@example.org')
    await clickRole('button', 'Change email…')
    await visible('[role="alertdialog"]')
    check('change email asks first', (await text('[data-slot="alert-dialog-title"]')) === 'Change the email of this license?')
    await confirmDialog('Change email')
    check('change email: toast', await waitForToast('Email changed to moved.address@example.org.'))
    await dialogClosed()
    check('change email: heading', (await text('[data-testid="license-email"]')) === 'moved.address@example.org')

    await clickRole('button', 'Add note')
    await fill('#license-note', 'Called about a late renewal. Extended by 90 days.')
    await clickRole('button', 'Save note')
    check('add note: toast', await waitForToast('Note saved.'))
    await dialogClosed()
    check('add note: shown', (await text('[data-testid="license-note"]')) === 'Called about a late renewal. Extended by 90 days.')

    await clickRole('button', 'Resend key')
    check('resend key: toast', await waitForToast('Key email queued for moved.address@example.org.'))

    await clickRole('button', 'Free seat')
    await visible('[role="alertdialog"]')
    check('free seat asks first', (await text('[data-slot="alert-dialog-title"]')) === 'Free this seat?')
    await confirmDialog('Free seat')
    check('free seat: toast', await waitForToast('Seat freed:'))
    check('free seat: summary and row', (await text('[data-testid="seats-summary"]')).startsWith('0 of 3 in use') && (await count('tr[data-seat-in-use="true"]')) === 0)

    await clickRole('button', 'Change plan')
    await clickRole('button', 'Change plan…')
    await visible('[role="alertdialog"]')
    check('change plan asks first', (await text('[data-slot="alert-dialog-title"]')) === 'Change plan to lifetime?')
    await confirmDialog('Change plan')
    check('change plan: toast', await waitForToast('Plan changed to lifetime.'))
    await dialogClosed()
    check('change plan: Extend no longer applies', await page.$eval(roleSelector('button', 'Extend'), (button) => button.disabled))

    await clickRole('button', 'Revoke')
    await confirmDialog('Revoke license')
    check('revoke: toast', await waitForToast('License revoked.'))
    await page.waitForSelector('[data-testid="license-badges"][data-license-state="revoked"]')
    check('revoke: Restore replaces Revoke', (await exists(roleSelector('button', 'Restore'))) && !(await exists(roleSelector('button', 'Revoke'))))
    check('revoke: newest event in the history', (await page.$eval('tr[data-event-type]', (row) => row.dataset.eventType)) === 'revoke')
    await clickRole('button', 'Restore')
    check('restore: toast', await waitForToast('License restored.'))
    check('restore: active again', await page.waitForSelector('[data-testid="license-badges"][data-license-state="active"]').then(() => true, () => false))

    await clickRole('button', 'Change plan')
    await visible('#plan-days')
    await fill('#plan-days', '45')
    await clickRole('button', 'Change plan…')
    await visible('[role="alertdialog"]')
    check('change plan back asks first', (await text('[data-slot="alert-dialog-title"]')) === 'Change plan to monthly?')
    await confirmDialog('Change plan')
    check('change plan back: toast', await waitForToast('Plan changed to monthly.'))
    await dialogClosed()
    check('change plan back: Extend applies again', !(await page.$eval(roleSelector('button', 'Extend'), (button) => button.disabled)))
    await toastsGone()
    await shot('25-license-after-actions')

    step('C5. Each action is in the audit log')
    await sidebar('Audit log', '/audit')
    await visible('tr[data-audit-action]')
    await settled()
    const expectedActions = [
      'license.change_plan',
      'license.restore',
      'license.revoke',
      'license.change_plan',
      'license.free_seat',
      'license.resend_key',
      'license.set_note',
      'license.change_email',
      'license.set_max_devices',
      'license.extend',
      'license.reveal_key',
    ]
    const logged = await auditRows()
    check(
      'newest rows are the eleven actions, in order, on this license',
      expectedActions.every((action, index) => logged[index]?.action === action && logged[index]?.target === `license:${target.id}`),
      logged.slice(0, expectedActions.length).map((row) => row.action).join(', '),
    )
    check('sign-ins are logged too', logged.some((row) => row.action === 'login'))
    check('fits 1280 px without sideways scrolling', await fitsWidth())
    await shot('60-audit-log')
    await choose('Action', 'Revoked license')
    check('action filter is in the address', await waitForLocation('/audit?action=license.revoke'))
    check('action filter', await allRows('tr[data-audit-action]', { auditAction: 'license.revoke' }), `${await count('tr[data-audit-action]')} rows`)
    await clickRole('link', `License #${target.id}`)
    check('an audit row links to its license', await waitForLocation(`/licenses/${target.id}`))
    await page.goBack()
    check('Back returns to the filtered audit log', await waitForLocation('/audit?action=license.revoke'))
    await page.goForward()
    await waitForLocation(`/licenses/${target.id}`)
    await clickRole('link', 'Admin actions on this license')
    check('a license links to its own audit rows', await waitForLocation(`/audit?target=license%3A${target.id}`), await location())
    const onlyOwn = await allRows('tr[data-audit-action]', { auditTarget: `license:${target.id}` })
    check('target filter', onlyOwn && (await count('tr[data-audit-action]')) >= expectedActions.length && (await exists('[data-testid="audit-target-filter"]')), `${await count('tr[data-audit-action]')} rows`)
    await shot('61-audit-log-one-license')

    step('C6. Search by PayPal id, then a revoked license')
    await sidebar('Licenses', '/licenses')
    await visible('tr[data-license-id]')
    await fill('[role="searchbox"]', payerId)
    const byPayer = await eventually((id) => document.querySelector('[aria-busy="true"]') === null && document.querySelector(`tr[data-license-id="${id}"]`) !== null && document.querySelectorAll('tr[data-license-id]').length <= 3, target.id)
    check('search by PayPal payer id', byPayer, `${payerId}: ${await count('tr[data-license-id]')} row(s)`)
    await fill('[role="searchbox"]', subscriptionId)
    const bySubscription = await eventually((id) => document.querySelector('[aria-busy="true"]') === null && document.querySelector(`tr[data-license-id="${id}"]`) !== null && document.querySelectorAll('tr[data-license-id]').length === 1, target.id)
    check('search by PayPal subscription id', bySubscription, `${subscriptionId}: ${await count('tr[data-license-id]')} row(s)`)
    await clickRole('button', 'Clear search')
    await waitForLocation('/licenses')
    await choose('Status', 'Revoked')
    await waitForLocation('/licenses?state=revoked')
    check('status filter: revoked', await allRows('tr[data-license-id]', { licenseState: 'revoked' }), `${await count('tr[data-license-id]')} rows`)
    const revokedRows = await licenseRows()
    // One whose Mac still holds the seat, if there is one: it has more to show.
    const revokedOne = revokedRows.find((row) => row.seatsUsed > 0) ?? revokedRows[0]
    await (await visible(`tr[data-license-id="${revokedOne.id}"] a`)).click()
    check('the email link opens the license', await waitForLocation(`/licenses/${revokedOne.id}`))
    await page.waitForSelector('[data-testid="license-badges"][data-license-state="revoked"]')
    check('revoked license offers Restore, not Revoke', (await exists(roleSelector('button', 'Restore'))) && !(await exists(roleSelector('button', 'Revoke'))))
    await shot('26-license-revoked')

    step('C7. New license')
    await sidebar('New license', '/licenses/new')
    await visible('#new-email')
    await shot('30-new-license')
    await clickRole('button', 'Create license')
    await visible('[data-slot="field-error"]')
    check('an empty email is caught before sending', (await text('[data-slot="field-error"]')) === 'Enter a valid email address.')
    await fill('#new-email', 'gift.for.a.friend@example.com')
    await clickRole('radio', 'Monthly')
    await clickRole('radio', '90 d')
    await fill('#new-max-devices', '2')
    await fill('#new-note', 'Gift, 90 days, two Macs')
    await shot('31-new-license-filled')
    await clickRole('button', 'Create license')
    check('created: opens the new license', await waitForLocation('/licenses/343'), await location())
    check('created: toast', await waitForToast('License created.'))
    await visible('[data-testid="created-notice"]')
    check('created: the new key is shown once', KEY_PATTERN.test(await text('[data-testid="license-key"]')))
    check('created: manual monthly license for 2 Macs', (await text('[data-testid="license-email"]')) === 'gift.for.a.friend@example.com' && (await text('[data-testid="seats-summary"]')).startsWith('0 of 2 in use') && (await text('[data-testid="license-note"]')) === 'Gift, 90 days, two Macs')
    await toastsGone()
    await shot('32-license-created')
    await sidebar('Licenses', '/licenses')
    await visible('tr[data-license-id]')
    await settled()
    check('created: first in the list, 343 licenses now', (await licenseRows())[0].id === 343 && (await rangeIs('1–50 of 343 licenses')))
    await sidebar('Audit log', '/audit')
    await visible('tr[data-audit-action]')
    await settled()
    check('created: in the audit log', (await auditRows())[0].action === 'license.create' && (await auditRows())[0].target === 'license:343')

    step('C8. Trials')
    await sidebar('Trials', '/trials')
    await visible('tr[data-trial-state]')
    await settled()
    check('50 trials on the first page', (await count('tr[data-trial-state]')) === 50 && (await rangeIs('1–50 of 260 trials')))
    check('fits 1280 px without sideways scrolling', await fitsWidth())
    await shot('40-trials')
    await clickRole('radio', 'On trial')
    check('status filter is in the address', await waitForLocation('/trials?state=active'))
    check(
      'On trial: as many as the dashboard counts, every row still running',
      (await totalIs(before.onTrial, 'trials')) && (await allRows('tr[data-trial-state]', { trialState: 'active' })),
      await text('[data-testid="pager-range"]'),
    )
    await clickRole('radio', 'Ended')
    await waitForLocation('/trials?state=ended')
    check(
      'Ended: all the others, every row ended',
      (await totalIs(260 - before.onTrial, 'trials')) && (await allRows('tr[data-trial-state]', { trialState: 'ended' })),
      await text('[data-testid="pager-range"]'),
    )

    step('C9. Settings')
    await sidebar('Settings', '/settings')
    await visible('#settings-trial-days')
    check('nothing to save at first', (await text('[data-testid="settings-status"]')) === 'Everything is saved.' && (await page.$eval(roleSelector('button', 'Save changes'), (button) => button.disabled)))
    check('PayPal plan id is read-only and not set', (await text('[data-testid="paypal-plan-id"]')) === 'Not set yet')
    await shot('50-settings')
    await fill('#settings-trial-days', '10')
    await fill('#settings-price-monthly', '5.5')
    check('edited: unsaved changes', (await text('[data-testid="settings-status"]')) === 'You have unsaved changes.')
    await clickRole('button', 'Save changes')
    check('save: toast', await waitForToast('Settings saved.'))
    await page.waitForFunction(() => document.querySelector('[data-testid="settings-status"]')?.textContent === 'Everything is saved.')
    check('save: the stored values come back', (await value('#settings-trial-days')) === '10' && (await value('#settings-price-monthly')) === '5.50')
    await sidebar('Trials', '/trials')
    await sidebar('Settings', '/settings')
    await visible('#settings-trial-days')
    check('still there after leaving the page', (await value('#settings-trial-days')) === '10')
    await fill('#settings-trial-days', '0')
    await fill('#settings-download-url', 'http://not-https.example/NotchOS.dmg')
    await clickRole('button', 'Save changes')
    await visible('[data-slot="field-error"]')
    check('the server refuses bad values, shown on their fields', (await count('[data-slot="field-error"]')) === 2)
    await toastsGone()
    await shot('51-settings-refused')
    await clickRole('button', 'Discard')
    check('Discard puts the saved values back', (await value('#settings-trial-days')) === '10' && (await text('[data-testid="settings-status"]')) === 'Everything is saved.')
    await sidebar('Audit log', '/audit')
    await visible('tr[data-audit-action]')
    await settled()
    const newest = (await auditRows())[0]
    check('the settings change is in the audit log', newest.action === 'settings.update' && newest.detail === 'prices.monthly: 4.99 → 5.50; trial_days: 7 → 10', newest.detail)

    step('C10. The dashboard counts what was done')
    await sidebar('Dashboard', '/')
    await visible('[data-testid="sales-today"]')
    // The numbers from the first visit are shown at once and replaced when the fresh ones arrive.
    // The license that was worked on is monthly and active again; one manual monthly license
    // was created (+1).
    const counted = await eventually(
      (monthly, lifetime) => {
        const read = (testId) => document.querySelector(`[data-testid="${testId}"]`)?.textContent?.replace(/[^\d]/g, '')
        return read('active-monthly') === String(monthly) && read('active-lifetime') === String(lifetime)
      },
      before.monthly + 1,
      before.lifetime,
    )
    check('active licenses: one more monthly, lifetime unchanged', counted, `before ${JSON.stringify(before)}, now monthly ${await counter('active-monthly')} lifetime ${await counter('active-lifetime')}`)

    // =====================================================================================
    // D. Reloading
    // =====================================================================================

    step('D1. A reload starts the mock data again, and keeps the sidebar setting')
    await load('/licenses/343')
    await visible('[data-slot="empty"]')
    check('the license created in this visit is gone after a reload', (await text('[data-slot="empty-title"]')) === 'License not found')
    await load('/licenses')
    await visible('tr[data-license-id]')
    await clickRole('button', 'Toggle Sidebar')
    await page.waitForSelector('[data-slot="sidebar"][data-state="collapsed"]')
    await settled()
    await shot('71-sidebar-collapsed')
    await page.reload({ waitUntil: 'load' })
    await visible('tr[data-license-id]')
    check('a collapsed sidebar stays collapsed after a reload', await exists('[data-slot="sidebar"][data-state="collapsed"]'))
    await clickRole('button', 'Toggle Sidebar')
    await page.waitForSelector('[data-slot="sidebar"][data-state="expanded"]')

    // =====================================================================================
    // E. Things going wrong
    // =====================================================================================

    step('E0. A refresh in the background fails: the rows stay and a notice says so')
    await load('/licenses')
    await visible('tr[data-license-id]')
    await settled()
    // The list is fetched again when the window comes back into view. This time the server fails.
    await page.evaluate(() => {
      window.history.replaceState(window.history.state, '', '/licenses?mock=error')
      window.dispatchEvent(new Event('visibilitychange'))
    })
    const keptRows = await eventually(
      () =>
        [...document.querySelectorAll('[data-slot="alert-title"]')].some((title) => title.textContent === 'Could not refresh') &&
        document.querySelectorAll('tr[data-license-id]').length === 50,
    )
    check('the 50 rows are still there, under a "Could not refresh" notice', keptRows)
    await shot('19-licenses-refresh-failed')

    step('E1. A license with no seats and no events yet')
    await load(`/licenses/${target.id}?mock=empty`)
    await visible('[data-testid="license-email"]')
    check('says so in both panels', (await text('[data-testid="seats-summary"]')).startsWith('0 of 1 in use') && !(await exists('tr[data-event-type]')))
    await shot('27-license-nothing-yet')

    step('E2. A failed write shows an error and changes nothing')
    await load(`/licenses/${target.id}?mock=write-error`)
    await visible('[data-testid="license-email"]')
    await clickRole('button', 'Resend key')
    check('error toast', await waitForToast('Could not resend the key'))
    await shot('72-error-toast', { fullPage: false })
    await clickRole('button', 'Add note')
    await fill('#license-note', 'This will not be saved')
    await clickRole('button', 'Save note')
    await visible('[role="dialog"] [data-slot="alert"]')
    check('a failed save stays in its dialog with the reason', (await text('[role="dialog"] [data-slot="alert-title"]')) === 'Could not save')
    await toastsGone()
    await shot('73-dialog-save-failed', { fullPage: false })

    step('E3. The session ends: the next call goes to login and comes back')
    await load('/settings')
    await visible('#settings-trial-days')
    await page.evaluate((key) => window.localStorage.removeItem(key), SESSION_STORAGE_KEY)
    await clickRole('link', 'Trials')
    check('a not-signed-in answer sends the admin to login', await waitForLocation('/login?next=%2Ftrials'), await location())
    await signIn('owner')
    check('and back to the page after signing in', await waitForLocation('/trials'), await location())
    await visible('tr[data-trial-state]')
    check('the new admin name is in the top bar', (await text('[data-testid="user-menu"]')) === 'owner')

    step('E4. Sign out')
    await (await visible('[data-testid="user-menu"]')).click()
    await clickRole('menuitem', 'Sign out')
    check('sign out returns to the login screen', await page.waitForFunction(() => window.location.pathname === '/login').then(() => true, () => false), await location())
    await visible('#login-username')
    await load('/')
    check('signed out: the dashboard is not reachable', await waitForLocation('/login'))
    check('signed out: the session marker is gone', (await page.evaluate((key) => window.localStorage.getItem(key), SESSION_STORAGE_KEY)) === null)

    step('E5. The API cannot be reached')
    await load('/?mock=offline')
    await visible('[data-slot="alert"]')
    check('says so instead of showing the login form', (await text('[data-slot="alert-title"]')) === 'Could not reach the admin API')
    await shot('74-api-unreachable')

    // =====================================================================================
    // F. A wider window
    // =====================================================================================

    step('F1. 1680 px wide')
    await page.setViewport({ width: 1680, height: 1000, deviceScaleFactor: 2 })
    await load('/login?next=%2Flicenses')
    await signIn()
    await waitForLocation('/licenses')
    await visible('tr[data-license-id]')
    await settled()
    await shot('80-licenses-1680')
    await load(`/licenses/${target.id}`)
    await visible('[data-testid="license-email"]')
    await shot('81-license-1680')

    step('F2. 1024 px wide (narrower than the supported 1280 px; only to see nothing breaks)')
    await page.setViewport({ width: 1024, height: 768, deviceScaleFactor: 2 })
    await load('/licenses')
    await visible('tr[data-license-id]')
    await settled()
    check('the page itself does not scroll sideways', await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
    await shot('82-licenses-1024')
    await load(`/licenses/${target.id}`)
    await visible('[data-testid="license-email"]')
    check('the license page does not scroll sideways', await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
    await shot('83-license-1024')
    await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 2 })

    step('G. Browser console and network, over the whole run')
    check('no console errors or warnings, no failed requests', consoleProblems.length === 0, consoleProblems.slice(0, 8).join(' | '))
    check(`every request went to ${ORIGIN}`, foreignRequests.length === 0, foreignRequests.slice(0, 5).join(' | '))
    check('no /api request left the page (the mock answers in the browser)', apiRequests.length === 0, apiRequests.slice(0, 5).join(' | '))
  } catch (error) {
    // Something the script waited for never came. Record where, and what the page looked like.
    const reason = error instanceof Error ? error.message.split('\n')[0] : String(error)
    check('the run got to the end', false, reason)
    if (page !== undefined) {
      const where = await page.evaluate(() => window.location.pathname + window.location.search).catch(() => 'unknown')
      console.log(`  stopped at ${where}`)
      if (SHOTS) {
        await page.screenshot({ path: path.join(OUT_DIR, 'zz-stopped-here.png') }).catch(() => {})
        console.log('  shot zz-stopped-here.png')
      }
    }
  } finally {
    if (browser !== undefined) {
      await browser.close()
    }
    await server.stop()
    await rm(profileDir, { recursive: true, force: true })
  }

  const failed = results.filter((result) => !result.passed)
  console.log(`\n${results.length - failed.length} of ${results.length} checks passed.`)
  for (const failure of failed) {
    console.log(`FAILED  ${failure.step}  >  ${failure.name}`)
  }
  if (SHOTS) {
    const files = (await readdir(OUT_DIR)).filter((file) => file.endsWith('.png')).sort()
    console.log(`${files.length} screenshots in ${OUT_DIR}`)
  }
  console.log(`Port ${PORT} is ${(await portIsOpen()) ? 'STILL IN USE' : 'free again'}.`)
  process.exitCode = failed.length === 0 ? 0 : 1
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
