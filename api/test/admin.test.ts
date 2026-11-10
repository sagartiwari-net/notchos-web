// The admin API (/admin/*): crypto helpers, login with password + TOTP, the session cookie,
// the same-site check for writes, and the license / trial / settings / audit routes.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from '../src/crypto/password.ts';
import { SecretBox, totpSecretAad } from '../src/crypto/secret-box.ts';
import { base32Decode, base32Encode, generateTotp, generateTotpSecret, otpauthUrl, verifyTotp } from '../src/crypto/totp.ts';
import { addDays, toIso } from '../src/lib/time.ts';
import { runCli } from '../src/cli/index.ts';
import type { CliIo } from '../src/cli/command.ts';
import type { Harness } from './helpers/harness.ts';
import { createHarness, deviceId, MIGRATIONS_DIR } from './helpers/harness.ts';

const ORIGIN = { origin: 'http://localhost' };
const PASSWORD = 'correct horse battery staple';

describe('crypto helpers', () => {
  it('matches the RFC 6238 SHA-1 test vector and accepts one step of drift', () => {
    const secret = Buffer.from('12345678901234567890', 'ascii');
    // RFC 6238 appendix B: T = 59 s -> 94287082; the 6-digit code is its last six digits.
    expect(generateTotp(secret, new Date(59_000))).toBe('287082');
    expect(generateTotp(secret, new Date(1_111_111_109_000))).toBe('081804');
    expect(verifyTotp(secret, '287082', new Date(59_000))).toBe(true);
    expect(verifyTotp(secret, '287082', new Date(59_000 + 30_000))).toBe(true);
    expect(verifyTotp(secret, '287082', new Date(59_000 + 90_000))).toBe(false);
    expect(verifyTotp(secret, '12345', new Date(59_000))).toBe(false);
    expect(verifyTotp(secret, 'abcdef', new Date(59_000))).toBe(false);
  });

  it('round-trips base32 and builds an otpauth URL', () => {
    const secret = generateTotpSecret();
    expect(secret).toHaveLength(20);
    expect(base32Decode(base32Encode(secret)).equals(secret)).toBe(true);
    expect(base32Encode(Buffer.from('foobar'))).toBe('MZXW6YTBOI');
    const url = otpauthUrl({ issuer: 'NotchOS Admin', account: 'alice', secret });
    expect(url).toContain('otpauth://totp/NotchOS%20Admin:alice?');
    expect(url).toContain(`secret=${base32Encode(secret)}`);
  });

  it('hashes passwords with scrypt and verifies them', async () => {
    const hash = await hashPassword(PASSWORD);
    expect(hash.startsWith('scrypt$')).toBe(true);
    expect(await verifyPassword(PASSWORD, hash)).toBe(true);
    expect(await verifyPassword('wrong', hash)).toBe(false);
    expect(await verifyPassword(PASSWORD, 'garbage')).toBe(false);
  });

  it('binds an encrypted secret to its username', () => {
    const box = new SecretBox(Buffer.alloc(32, 7));
    const stored = box.encrypt(Buffer.from('secret'), totpSecretAad('alice'));
    expect(box.decrypt(stored, totpSecretAad('alice')).toString()).toBe('secret');
    expect(() => box.decrypt(stored, totpSecretAad('bob'))).toThrow();
  });
});

describe('admin API', () => {
  let h: Harness;
  let totpSecret: Buffer;
  let cookie = '';

  beforeAll(async () => {
    h = await createHarness({ rateLimit: {} });
    totpSecret = generateTotpSecret();
    await h.sql.execute('INSERT INTO admin_users (username, password_hash, totp_secret_enc) VALUES (?, ?, ?)', [
      'alice',
      await hashPassword(PASSWORD),
      h.ctx.secretBox.encrypt(totpSecret, totpSecretAad('alice')),
    ]);
  });
  afterAll(async () => {
    await h.close();
  });

  async function call(
    method: 'GET' | 'POST' | 'PUT',
    url: string,
    body?: unknown,
    options: { cookie?: string | null; headers?: Record<string, string>; ip?: string } = {},
  ) {
    const headers: Record<string, string> = { ...(method === 'GET' ? {} : ORIGIN), ...options.headers };
    const useCookie = options.cookie === undefined ? cookie : options.cookie;
    if (useCookie) headers.cookie = useCookie;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const raw = await h.app.inject({
      method,
      url: `/admin${url}`,
      headers,
      payload: body === undefined ? undefined : JSON.stringify(body),
      remoteAddress: options.ip ?? '198.51.100.20',
    });
    let json: any;
    try {
      json = JSON.parse(raw.body);
    } catch {
      json = raw.body;
    }
    return { status: raw.statusCode, body: json, headers: raw.headers };
  }

  const code = () => generateTotp(totpSecret, h.clock.now());

  async function signIn(): Promise<void> {
    const res = await call('POST', '/login', { username: 'alice', password: PASSWORD, code: code() }, { cookie: null });
    expect(res.status).toBe(200);
    cookie = String(res.headers['set-cookie']).split(';')[0]!;
  }

  describe('login', () => {
    it('answers 401 not_signed_in without a session', async () => {
      for (const path of ['/session', '/licenses', '/dashboard', '/settings', '/audit-log']) {
        const res = await call('GET', path, undefined, { cookie: null });
        expect(res.status, path).toBe(401);
        expect(res.body.error).toBe('not_signed_in');
      }
    });

    it('refuses a wrong code, a wrong password and an unknown user with the same answer', async () => {
      const wrongCode = await call('POST', '/login', { username: 'alice', password: PASSWORD, code: '000000' }, { cookie: null, ip: '203.0.113.1' });
      const wrongPassword = await call('POST', '/login', { username: 'alice', password: 'nope nope nope', code: code() }, { cookie: null, ip: '203.0.113.2' });
      const unknown = await call('POST', '/login', { username: 'mallory', password: PASSWORD, code: code() }, { cookie: null, ip: '203.0.113.3' });
      for (const res of [wrongCode, wrongPassword, unknown]) {
        expect(res.status).toBe(401);
        expect(res.body.error).toBe('invalid_credentials');
        expect(res.headers['set-cookie']).toBeUndefined();
      }
    });

    it('rate limits login to 5 tries per 15 minutes per address', async () => {
      const attempt = () =>
        call('POST', '/login', { username: 'alice', password: 'wrong password!', code: '000000' }, { cookie: null, ip: '203.0.113.99' });
      for (let i = 0; i < 5; i++) expect((await attempt()).status).toBe(401);
      const limited = await attempt();
      expect(limited.status).toBe(429);
      expect(limited.body.error).toBe('rate_limited');
      expect(limited.body.retry_after).toBeGreaterThan(0);
    });

    it('refuses a login that does not come from the same site', async () => {
      const res = await call(
        'POST',
        '/login',
        { username: 'alice', password: PASSWORD, code: code() },
        { cookie: null, headers: { origin: 'https://evil.example' }, ip: '203.0.113.50' },
      );
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('forbidden');
      const noOrigin = await h.app.inject({
        method: 'POST',
        url: '/admin/login',
        headers: { 'content-type': 'application/json' },
        payload: '{}',
      });
      expect(noOrigin.statusCode).toBe(403);
      const referer = await h.app.inject({
        method: 'POST',
        url: '/admin/login',
        headers: { 'content-type': 'application/json', referer: 'http://localhost/login' },
        payload: JSON.stringify({ username: 'alice', password: 'x', code: '000000' }),
      });
      expect(referer.statusCode).toBe(401);
    });

    it('signs in, sets a hardened cookie, stores only its hash, and ends the session on logout', async () => {
      const res = await call('POST', '/login', { username: 'alice', password: PASSWORD, code: code() }, { cookie: null, ip: '203.0.113.60' });
      expect(res.status).toBe(200);
      expect(res.body.admin).toMatchObject({ username: 'alice' });
      expect(res.body.expires_at).toBe(toIso(addDays(h.clock.now(), 0.5)));

      const setCookie = String(res.headers['set-cookie']);
      expect(setCookie).toMatch(/^notchos_admin_session=[A-Za-z0-9_-]{40,}; Path=\/; HttpOnly; SameSite=Strict; Max-Age=43200$/);
      const value = setCookie.split(';')[0]!.split('=')[1]!;
      const rows = await h.sql.query('SELECT id_hash FROM admin_sessions');
      expect(rows).toHaveLength(1);
      expect(rows[0].id_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(rows[0].id_hash).not.toContain(value);

      const mine = `notchos_admin_session=${value}`;
      expect((await call('GET', '/session', undefined, { cookie: mine })).body.admin.username).toBe('alice');

      const out = await call('POST', '/logout', {}, { cookie: mine });
      expect(out.status).toBe(200);
      expect(String(out.headers['set-cookie'])).toContain('Max-Age=0');
      expect((await call('GET', '/session', undefined, { cookie: mine })).status).toBe(401);
    });

    it('expires a session after 12 hours', async () => {
      await signIn();
      expect((await call('GET', '/session')).status).toBe(200);
      h.clock.advanceSeconds(12 * 3600 + 1);
      expect((await call('GET', '/session')).status).toBe(401);
      h.clock.advanceSeconds(-(12 * 3600 + 1));
    });

    it('marks the cookie Secure in production', async () => {
      const { sessionCookieHeader } = await import('../src/admin/auth.ts');
      expect(sessionCookieHeader({ ...h.config, nodeEnv: 'production' }, 'abc', 10)).toContain('; Secure');
      expect(sessionCookieHeader(h.config, 'abc', 10)).not.toContain('Secure');
    });
  });

  describe('with a session', () => {
    beforeAll(async () => {
      await signIn();
    });

    it('refuses writes from another site even with a valid session', async () => {
      const res = await call('POST', '/licenses', { email: 'a@b.co', plan: 'lifetime' }, { headers: { origin: 'https://evil.example' } });
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('forbidden');
    });

    it('creates, lists, shows and reveals a license, and audits each write', async () => {
      const bad = await call('POST', '/licenses', { email: 'nope', plan: 'monthly' });
      expect(bad.status).toBe(400);
      expect(bad.body.fields).toMatchObject({ email: expect.any(String), period_end: expect.any(String) });

      const periodEnd = toIso(addDays(h.clock.now(), 30));
      const created = await call('POST', '/licenses', { email: 'buyer@example.com', plan: 'monthly', period_end: periodEnd, max_devices: 2, note: 'hello' });
      expect(created.status).toBe(201);
      expect(created.body.key).toMatch(/^NOS-[A-Z2-9]{5}-[A-Z2-9]{5}-[A-Z2-9]{5}-[A-Z2-9]{5}$/);
      expect(created.body.license).toMatchObject({
        email: 'buyer@example.com', plan: 'monthly', status: 'active', max_devices: 2, source: 'manual',
        period_end: periodEnd, expires_at: periodEnd, auto_renew: false, note: 'hello',
      });
      expect(created.body.license.key_hint).toBe(created.body.key.slice(-4));
      expect(created.body.license).not.toHaveProperty('key_hash');
      expect(created.body.license).not.toHaveProperty('key_enc');
      const id = created.body.license.id;

      const list = await call('GET', '/licenses?q=buyer&state=active&plan=monthly');
      expect(list.body).toMatchObject({ total: 1, page: 1, page_size: 50 });
      expect(list.body.items[0]).toMatchObject({ id, state: 'active', seats_used: 0, last_seen_at: null });
      expect((await call('GET', `/licenses?q=${created.body.key}`)).body.total).toBe(1);
      expect((await call('GET', `/licenses?q=${created.body.key.slice(-4)}`)).body.total).toBe(1);
      expect((await call('GET', '/licenses?state=revoked')).body.total).toBe(0);
      expect((await call('GET', '/licenses?state=bogus')).status).toBe(400);

      const detail = await call('GET', `/licenses/${id}`);
      expect(detail.body).toMatchObject({ state: 'active', activations: [], events: [], events_total: 0 });
      expect((await call('GET', '/licenses/999999')).status).toBe(404);
      expect((await call('GET', '/licenses/abc')).status).toBe(404);

      const reveal = await call('POST', `/licenses/${id}/reveal-key`, {});
      expect(reveal.body.key).toBe(created.body.key);

      const audit = await call('GET', `/audit-log?target=license:${id}`);
      expect(audit.body.items.map((row: any) => row.action)).toEqual(['license.reveal_key', 'license.create']);
      expect(audit.body.items[0]).toMatchObject({ admin_username: 'alice', ip: '198.51.100.20' });
      expect(JSON.stringify(audit.body)).not.toContain(created.body.key);
    });

    it('runs the license actions', async () => {
      const lic = await h.newLicense('monthly', { days: 10 });
      const id = lic.id;
      const device = deviceId('seat-1');
      const now = h.clock.now();
      const seat = await h.sql.execute(
        'INSERT INTO activations (license_id, device_id, device_name, activated_at, last_seen_at) VALUES (?, ?, ?, ?, ?)',
        [id, device, 'Studio Mac', now, now],
      );
      const activationId = Number(seat.insertId);

      expect((await call('GET', `/licenses/${id}`)).body.activations[0]).toMatchObject({ id: activationId, deactivated_at: null });
      expect((await call('POST', `/licenses/${id}/max-devices`, { max_devices: 0 })).status).toBe(400);
      expect((await call('POST', `/licenses/${id}/max-devices`, { max_devices: 3 })).body.license.max_devices).toBe(3);

      const freed = await call('POST', `/licenses/${id}/activations/${activationId}/free`, {});
      expect(freed.status).toBe(200);
      expect(freed.body.activations[0].deactivated_at).toBe(toIso(now));
      expect(freed.body.events[0].type).toBe('deactivate');
      expect((await call('POST', `/licenses/${id}/activations/999999/free`, {})).status).toBe(404);
      const moves = await call('GET', `/seat-moves?q=${id}`);
      expect(moves.body.items[0]).toMatchObject({ reason: 'admin_free_seat', actor: 'admin', from_device_name: 'Studio Mac' });

      const revoked = await call('POST', `/licenses/${id}/revoke`, {});
      expect(revoked.body).toMatchObject({ state: 'revoked', license: { status: 'revoked' } });
      expect((await call('POST', `/licenses/${id}/restore`, {})).body.state).toBe('active');

      const later = toIso(addDays(now, 40));
      expect((await call('POST', `/licenses/${id}/extend`, { period_end: toIso(addDays(now, 1)) })).status).toBe(400);
      const extended = await call('POST', `/licenses/${id}/extend`, { period_end: later });
      expect(extended.body.license).toMatchObject({ period_end: later, expires_at: later });
      expect(extended.body.events[0].type).toBe('renew');

      expect((await call('POST', `/licenses/${id}/plan`, { plan: 'monthly', period_end: later })).status).toBe(409);
      const lifetime = await call('POST', `/licenses/${id}/plan`, { plan: 'lifetime' });
      expect(lifetime.body.license).toMatchObject({ plan: 'lifetime', period_end: null, expires_at: null, auto_renew: false });
      expect((await call('POST', `/licenses/${id}/extend`, { period_end: later })).status).toBe(409);
      expect((await call('POST', `/licenses/${id}/plan`, { plan: 'monthly', period_end: later })).body.license.plan).toBe('monthly');

      expect((await call('POST', `/licenses/${id}/email`, { email: 'bad' })).status).toBe(400);
      expect((await call('POST', `/licenses/${id}/email`, { email: 'new@example.com' })).body.license.email).toBe('new@example.com');
      expect((await call('POST', `/licenses/${id}/note`, { note: '  vip ' })).body.license.note).toBe('vip');
      expect((await call('POST', `/licenses/${id}/note`, { note: '' })).body.license.note).toBeNull();
      expect((await call('POST', `/licenses/${id}/resend-key`, {})).body.to_email).toBe('new@example.com');
      expect((await call('POST', '/licenses/999999/revoke', {})).status).toBe(404);

      const actions = (await call('GET', `/audit-log?target=license:${id}&page_size=100`)).body.items.map((r: any) => r.action);
      expect(actions).toEqual(expect.arrayContaining([
        'license.set_max_devices', 'license.free_seat', 'license.revoke', 'license.restore', 'license.extend',
        'license.change_plan', 'license.change_email', 'license.set_note', 'license.resend_key',
      ]));
    });

    it('grants, looks up and resets trials; lists leads and the dashboard', async () => {
      const device = deviceId('trial-device');
      expect((await call('POST', '/trials', { device_id: 'short' })).status).toBe(400);
      const first = await call('POST', '/trials', { device_id: device, days: 3, email: 'T@Example.com' });
      expect(first.status).toBe(201);
      expect(first.body).toMatchObject({ device_id: device, email: 't@example.com', state: 'active', converted_license_id: null });
      expect((await call('POST', '/trials', { device_id: device })).status).toBe(200);

      h.clock.advanceDays(4);
      await signIn(); // the 12-hour session ended
      expect((await call('POST', '/trials', { device_id: device })).status).toBe(409);
      const reset = await call('POST', '/trials', { device_id: device, reset: true, days: 5 });
      expect(reset.status).toBe(200);
      expect(reset.body.state).toBe('active');
      expect((await call('GET', '/trials?state=active')).body.total).toBe(1);
      expect((await call('GET', '/trials?state=ended')).body.total).toBe(0);
      expect((await call('GET', '/trial-leads')).body).toMatchObject({ items: [], total: 0 });

      const dash = await call('GET', '/dashboard');
      expect(dash.status).toBe(200);
      expect(dash.body).toMatchObject({
        currency: 'USD',
        sales: { today: { count: 0, amount: '0.00' } },
        trials: { active: 1, started_total: 1, converted_total: 0 },
        failed_emails: 0, unprocessed_webhooks: 0, open_disputes: 0,
      });
      expect(dash.body.active_licenses.monthly + dash.body.active_licenses.lifetime).toBeGreaterThan(0);
    });

    it('reads and saves settings, keeps the SMTP password write-only', async () => {
      const initial = await call('GET', '/settings');
      expect(initial.body).toMatchObject({
        prices: { monthly: null, lifetime: null }, trial_days: 7, transfer_limit: 2, renewal_buffer_hours: 24,
        download_url: null, app_version: null, paypal_plan_id: null,
        mail: { mode: 'file', smtp_host: 'smtp.gmail.com', smtp_port: 465, smtp_secure: true, smtp_pass_set: false },
      });

      const bad = await call('PUT', '/settings', { ...initial.body, trial_days: 0, prices: { monthly: 'free', lifetime: null } });
      expect(bad.status).toBe(400);
      expect(bad.body.fields).toMatchObject({ trial_days: expect.any(String), 'prices.monthly': expect.any(String) });

      const update = {
        prices: { monthly: '4.99', lifetime: '29.9' },
        trial_days: 14, transfer_limit: 3, renewal_buffer_hours: 12,
        download_url: 'https://example.com/NotchOS.dmg', app_version: '0.7.0',
        mail: { mode: 'smtp', smtp_host: 'smtp.gmail.com', smtp_port: 465, smtp_secure: true, smtp_user: 'me@gmail.com', smtp_pass: 'app-password-123', mail_from: null, support_email: 'help@example.com' },
      };
      const saved = await call('PUT', '/settings', update);
      expect(saved.status).toBe(200);
      expect(saved.body).toMatchObject({
        prices: { monthly: '4.99', lifetime: '29.90' }, trial_days: 14, transfer_limit: 3, renewal_buffer_hours: 12,
        download_url: 'https://example.com/NotchOS.dmg', app_version: '0.7.0',
        mail: { mode: 'smtp', smtp_user: 'me@gmail.com', smtp_pass_set: true, support_email: 'help@example.com' },
      });
      expect(JSON.stringify(saved.body)).not.toContain('app-password-123');
      const stored = await h.sql.query("SELECT value FROM settings WHERE name = 'mail_smtp_pass'");
      expect(stored[0].value).toMatch(/^v1\./);
      expect(stored[0].value).not.toContain('app-password-123');

      // Omitting smtp_pass keeps it; smtp mode without one is refused after clearing.
      const kept = await call('PUT', '/settings', { ...update, mail: { ...update.mail, smtp_pass: undefined } });
      expect(kept.body.mail.smtp_pass_set).toBe(true);
      const cleared = await call('PUT', '/settings', { ...update, mail: { ...update.mail, smtp_pass: '' } });
      expect(cleared.status).toBe(400);
      expect(cleared.body.fields['mail.smtp_pass']).toBeTruthy();

      const audit = (await call('GET', '/audit-log?action=settings.update')).body.items;
      expect(audit.length).toBeGreaterThanOrEqual(2);
      expect(audit[audit.length - 1].detail).toContain('trial_days: 7 → 14');
      expect(JSON.stringify(audit)).not.toContain('app-password-123');
    });

    it('pages the audit log newest first', async () => {
      const page = await call('GET', '/audit-log?page=1&page_size=25');
      expect(page.body.page_size).toBe(25);
      const times = page.body.items.map((row: any) => row.id);
      expect(times).toEqual([...times].sort((a: number, b: number) => b - a));
      expect((await call('GET', '/audit-log?page=9999')).body.items).toEqual([]);
    });
  });
});

describe('admin:create', () => {
  it('creates an admin that can sign in, prints the secret once, and refuses a duplicate', async () => {
    const h = await createHarness();
    try {
      const env = {
        NOTCHOS_ENV_FILE: '', NOTCHOS_MIGRATE_ENV_FILE: '', NODE_ENV: 'test',
        DB_HOST: h.settings.host, DB_PORT: String(h.settings.port), DB_NAME: h.dbName,
        DB_USER: h.settings.api.user, DB_PASSWORD: h.settings.api.password,
        DB_MIGRATE_USER: h.settings.admin.user, DB_MIGRATE_PASSWORD: h.settings.admin.password,
        KEY_ENC_SECRET: h.config.keyEncSecret.toString('base64'),
        SIGNING_KEY_FILE: '/nonexistent/not-needed-by-the-cli', MIGRATIONS_DIR,
      };
      const run = async (args: string[]) => {
        const out: string[] = [];
        const err: string[] = [];
        const io: CliIo = { out: (l) => out.push(l), err: (l) => err.push(l), env, clock: h.clock };
        return { code: await runCli(args, io), out: out.join('\n'), err: err.join('\n') };
      };

      expect((await run(['admin:create', 'bob'])).code).toBe(2);
      expect((await run(['admin:create', 'bob', 'short'])).code).toBe(2);
      const ok = await run(['admin:create', 'bob', 'a long enough password']);
      expect(ok.code).toBe(0);
      const secret = /base32 secret\s+([A-Z2-7]+)/.exec(ok.out)![1]!;
      expect(ok.out).toContain('otpauth://totp/NotchOS%20Admin:bob?');
      expect((await run(['admin:create', 'bob', 'another long password'])).code).toBe(1);

      const code = generateTotp(base32Decode(secret), h.clock.now());
      const login = await h.app.inject({
        method: 'POST', url: '/admin/login',
        headers: { 'content-type': 'application/json', origin: 'http://localhost' },
        payload: JSON.stringify({ username: 'bob', password: 'a long enough password', code }),
      });
      expect(login.statusCode).toBe(200);
      expect(JSON.parse(login.body).admin.username).toBe('bob');
    } finally {
      await h.close();
    }
  });
});
