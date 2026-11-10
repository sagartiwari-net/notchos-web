// The command line: license:create, license:revoke, license:reset-seat, license:list and
// the db: commands, run in-process against a throwaway database.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CliIo } from '../src/cli/command.ts';
import { assertResettable } from '../src/cli/commands/db.ts';
import { COMMANDS, runCli } from '../src/cli/index.ts';
import type { EnvValues } from '../src/config.ts';
import { hashLicenseKey } from '../src/crypto/license-key.ts';
import { addDays, addSeconds, toIso } from '../src/lib/time.ts';
import type { Harness } from './helpers/harness.ts';
import { createHarness, deviceId, MIGRATIONS_DIR } from './helpers/harness.ts';

let h: Harness;
let env: EnvValues;

beforeAll(async () => {
  h = await createHarness();
  env = {
    // No env file: everything the CLI needs is given here, pointing at the test database.
    NOTCHOS_ENV_FILE: '',
    NOTCHOS_MIGRATE_ENV_FILE: '',
    NODE_ENV: 'test',
    DB_HOST: h.settings.host,
    DB_PORT: String(h.settings.port),
    DB_NAME: h.dbName,
    DB_USER: h.settings.api.user,
    DB_PASSWORD: h.settings.api.password,
    DB_MIGRATE_USER: h.settings.admin.user,
    DB_MIGRATE_PASSWORD: h.settings.admin.password,
    KEY_ENC_SECRET: h.config.keyEncSecret.toString('base64'),
    SIGNING_KEY_FILE: '/nonexistent/not-needed-by-the-cli',
    MIGRATIONS_DIR,
  };
});
afterAll(async () => {
  await h.close();
});

interface CliResult {
  code: number;
  out: string;
  err: string;
}

async function cli(args: string[], envOverride: EnvValues = env): Promise<CliResult> {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = { out: (line) => out.push(line), err: (line) => err.push(line), env: envOverride, clock: h.clock };
  const code = await runCli(args, io);
  return { code, out: out.join('\n'), err: err.join('\n') };
}

function keyIn(output: string): string {
  const match = /^\s*key\s+(NOS-[A-Z2-9]{5}-[A-Z2-9]{5}-[A-Z2-9]{5}-[A-Z2-9]{5})$/m.exec(output);
  if (match === null) throw new Error(`no key in:\n${output}`);
  return match[1]!;
}

function idIn(output: string): number {
  const match = /^\s*id\s+(\d+)$/m.exec(output);
  if (match === null) throw new Error(`no id in:\n${output}`);
  return Number(match[1]);
}

describe('license:create', () => {
  it('creates a lifetime license and prints the key once', async () => {
    const result = await cli(['license:create', 'buyer@example.com', 'lifetime']);
    expect(result.code).toBe(0);
    expect(result.err).toBe('');
    expect(result.out).toContain('expires  never (lifetime)');
    const key = keyIn(result.out);
    const id = idIn(result.out);

    const [row] = await h.sql.query<Record<string, unknown>[]>('SELECT * FROM licenses WHERE id = ?', [id]);
    expect(row).toMatchObject({
      key_hash: hashLicenseKey(key),
      key_hint: key.slice(-4),
      email: 'buyer@example.com',
      plan: 'lifetime',
      status: 'active',
      max_devices: 1,
      period_end: null,
      expires_at: null,
      auto_renew: 0,
      transfers_used: 0,
      source: 'manual',
      payer_id: null,
      created_at: h.clock.now(),
    });
    // Stored as hash + encrypted copy only; the copy decrypts back to the key.
    expect(JSON.stringify(row)).not.toContain(key);
    expect(h.ctx.keyCipher.decrypt(row!.key_enc as string, row!.key_hash as string)).toBe(key);

    // And the key really works.
    const res = await h.post('/v1/activate', { email: 'buyer@example.com', key, device_id: deviceId('mac-a') });
    expect(res.status).toBe(200);
    expect(h.payloadOf(res.body.token)).toMatchObject({ license_id: id, plan: 'lifetime', expires_at: null });
  });

  it('creates a monthly license for 30 days, or for --days N / --minutes N', async () => {
    const now = h.clock.now();
    const expiryOf = async (args: string[]): Promise<Date | null> => {
      const result = await cli(['license:create', 'buyer@example.com', 'monthly', ...args]);
      expect(result.code, result.err).toBe(0);
      const [row] = await h.sql.query<{ expires_at: Date; period_end: Date; note: string | null }[]>(
        'SELECT expires_at, period_end, note FROM licenses WHERE id = ?',
        [idIn(result.out)],
      );
      expect(row!.period_end).toEqual(row!.expires_at);
      expect(result.out).toContain(`expires  ${toIso(row!.expires_at)}`);
      return row!.expires_at;
    };

    expect(await expiryOf([])).toEqual(addDays(now, 30));
    expect(await expiryOf(['--days', '2'])).toEqual(addDays(now, 2));
    expect(await expiryOf(['--days=365'])).toEqual(addDays(now, 365));
    expect(await expiryOf(['--minutes', '5'])).toEqual(addSeconds(now, 300));
  });

  it('stores a note', async () => {
    const result = await cli(['license:create', 'team@example.com', 'lifetime', '--note', 'gift for the team']);
    const [row] = await h.sql.query<{ note: string }[]>('SELECT note FROM licenses WHERE id = ?', [idIn(result.out)]);
    expect(row!.note).toBe('gift for the team');
  });

  it('refuses wrong arguments with exit code 2 and creates nothing', async () => {
    const count = async (): Promise<number> =>
      (await h.sql.query<{ n: number }[]>('SELECT COUNT(*) AS n FROM licenses'))[0]!.n;
    const before = await count();

    const wrong: string[][] = [
      ['license:create'],
      ['license:create', 'buyer@example.com'],
      ['license:create', 'buyer@example.com', 'yearly'],
      ['license:create', 'not-an-email', 'lifetime'],
      ['license:create', 'buyer@example.com', 'lifetime', '--days', '30'],
      ['license:create', 'buyer@example.com', 'monthly', '--days', '0'],
      ['license:create', 'buyer@example.com', 'monthly', '--days', 'ten'],
      ['license:create', 'buyer@example.com', 'monthly', '--days', '3', '--minutes', '5'],
      ['license:create', 'buyer@example.com', 'monthly', '--forever'],
      ['license:create', 'buyer@example.com', 'monthly', 'extra'],
    ];
    for (const args of wrong) {
      const result = await cli(args);
      expect(result.code, args.join(' ')).toBe(2);
      expect(result.err).toContain('Usage: license:create <email> <monthly|lifetime>');
      expect(result.out).toBe('');
    }
    expect(await count()).toBe(before);
  });
});

describe('license:list', () => {
  it('lists licenses without ever showing a key', async () => {
    const created = await cli(['license:create', 'list-me@example.com', 'monthly', '--days', '2']);
    const key = keyIn(created.out);
    const id = idIn(created.out);
    await h.post('/v1/activate', { email: 'list-me@example.com', key, device_id: deviceId('mac-list'), device_name: 'Listed Mac' });

    const result = await cli(['license:list']);
    expect(result.code).toBe(0);
    const line = result.out.split('\n').find((row) => row.startsWith(`${id} `));
    expect(line).toBeDefined();
    expect(line!.split(/\s{2,}/)).toEqual([
      String(id),
      'monthly',
      'active',
      'list-me@example.com',
      `...${key.slice(-4)}`,
      toIso(addDays(h.clock.now(), 2)),
      '1/1',
      'Listed Mac',
      '0',
      toIso(h.clock.now()),
    ]);
    expect(result.out).not.toContain(key);
    expect(result.out).not.toMatch(/NOS-[A-Z2-9]{5}-/);
  });

  it('filters by email, plan and status, limits, and prints JSON', async () => {
    await cli(['license:create', 'filter-one@example.com', 'lifetime']);
    await cli(['license:create', 'filter-two@example.com', 'monthly']);

    const byEmail = await cli(['license:list', '--email', 'filter-', '--json']);
    const rows = JSON.parse(byEmail.out) as { email: string; plan: string; expires_at: string | null }[];
    expect(rows.map((row) => row.email).sort()).toEqual(['filter-one@example.com', 'filter-two@example.com']);
    expect(byEmail.out).not.toMatch(/NOS-[A-Z2-9]{5}-/);
    expect(byEmail.out).not.toContain('key_enc');
    expect(byEmail.out).not.toContain('key_hash');

    const lifetime = JSON.parse((await cli(['license:list', '--email', 'filter-', '--plan', 'lifetime', '--json'])).out);
    expect(lifetime).toHaveLength(1);
    expect(lifetime[0]).toMatchObject({ email: 'filter-one@example.com', expires_at: null, seats_used: 0 });

    expect(JSON.parse((await cli(['license:list', '--status', 'revoked', '--email', 'filter-', '--json'])).out)).toEqual([]);
    expect(JSON.parse((await cli(['license:list', '--limit', '1', '--json'])).out)).toHaveLength(1);
    // % and _ in the search text are plain characters, not wildcards.
    expect(JSON.parse((await cli(['license:list', '--email', '%', '--json'])).out)).toEqual([]);

    expect((await cli(['license:list', '--status', 'paused'])).code).toBe(2);
    expect((await cli(['license:list', '--limit', '0'])).code).toBe(2);
  });
});

describe('license:revoke', () => {
  it('revokes by id; the next refresh fails', async () => {
    const created = await cli(['license:create', 'refund@example.com', 'lifetime']);
    const key = keyIn(created.out);
    const id = idIn(created.out);
    const body = { email: 'refund@example.com', key, device_id: deviceId('mac-refund') };
    await h.post('/v1/activate', body);
    expect((await h.post('/v1/refresh', body)).status).toBe(200);

    const result = await cli(['license:revoke', String(id)]);
    expect(result).toEqual({ code: 0, out: `License ${id} revoked.`, err: '' });

    const refreshed = await h.post('/v1/refresh', body);
    expect(refreshed.status).toBe(403);
    expect(refreshed.body.error).toBe('revoked');

    expect(await cli(['license:revoke', String(id)])).toEqual({
      code: 0,
      out: `License ${id} was already revoked.`,
      err: '',
    });
    const events = await h.sql.query<{ type: string; detail: string }[]>(
      "SELECT type, detail FROM events WHERE license_id = ? AND type = 'revoke'",
      [id],
    );
    expect(events).toEqual([{ type: 'revoke', detail: 'cli' }]);
  });

  it('revokes by key, and says so when the license does not exist', async () => {
    const created = await cli(['license:create', 'refund2@example.com', 'lifetime']);
    const key = keyIn(created.out);
    const result = await cli(['license:revoke', key.toLowerCase()]);
    expect(result.code).toBe(0);
    expect(result.out).toBe(`License ${idIn(created.out)} revoked.`);

    for (const ref of ['999999', 'NOS-AAAAA-AAAAA-AAAAA-AAAAA', 'garbage']) {
      expect(await cli(['license:revoke', ref])).toEqual({ code: 1, out: '', err: 'No such license.' });
    }
    expect((await cli(['license:revoke'])).code).toBe(2);
  });
});

describe('license:reset-seat', () => {
  it('frees the seat so another Mac can activate without a transfer', async () => {
    const created = await cli(['license:create', 'seat@example.com', 'lifetime']);
    const key = keyIn(created.out);
    const id = idIn(created.out);
    await h.post('/v1/activate', { email: 'seat@example.com', key, device_id: deviceId('dead-mac'), device_name: 'Dead Mac' });
    expect((await h.post('/v1/activate', { email: 'seat@example.com', key, device_id: deviceId('new-mac') })).status).toBe(409);

    const result = await cli(['license:reset-seat', String(id)]);
    expect(result).toEqual({ code: 0, out: `License ${id}: freed 1 seat(s).`, err: '' });

    const res = await h.post('/v1/activate', { email: 'seat@example.com', key, device_id: deviceId('new-mac') });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ transferred: false, transfers_left: 2 });
    expect((await h.post('/v1/refresh', { key, device_id: deviceId('dead-mac') })).body.error).toBe('seat_moved');

    // Nothing to free the second time.
    await cli(['license:reset-seat', String(id)]);
    expect((await cli(['license:reset-seat', String(id)])).out).toBe(`License ${id}: freed 0 seat(s).`);
  });

  it('can also reset the transfer counter', async () => {
    const created = await cli(['license:create', 'moves@example.com', 'lifetime']);
    const key = keyIn(created.out);
    const id = idIn(created.out);
    const activate = (device: string, transfer = false) =>
      h.post('/v1/activate', { email: 'moves@example.com', key, device_id: deviceId(device), transfer });
    await activate('m1');
    await activate('m2', true);
    await activate('m3', true);
    expect((await activate('m4', true)).body.error).toBe('transfer_limit_reached');

    const plain = await cli(['license:reset-seat', key]);
    expect(plain.out).toBe(`License ${id}: freed 1 seat(s).`);
    expect((await activate('m4')).body).toMatchObject({ transferred: false, transfers_left: 0 });

    const withCounter = await cli(['license:reset-seat', String(id), '--reset-transfers']);
    expect(withCounter.out).toBe(`License ${id}: freed 1 seat(s).\nLicense ${id}: transfer counter reset to 0.`);
    expect((await activate('m5')).body).toMatchObject({ transferred: false, transfers_left: 2 });
  });

  it('says so when the license does not exist', async () => {
    expect(await cli(['license:reset-seat', '999999'])).toEqual({ code: 1, out: '', err: 'No such license.' });
  });
});

describe('db commands', () => {
  it('db:migrate and db:status report an up-to-date schema', async () => {
    const migrated = await cli(['db:migrate']);
    expect(migrated).toEqual({ code: 0, out: `${h.dbName}: schema is up to date`, err: '' });

    const status = await cli(['db:status']);
    expect(status.code).toBe(0);
    expect(status.out).toContain(`database ${h.dbName} at ${h.settings.host}:${h.settings.port}`);
    expect(status.out).toMatch(/001_init\.sql\s+applied\s+2026-11-10T08:00:00Z/);
  });

  it('db:reset only ever touches notchos_dev', async () => {
    const before = await h.sql.query<{ n: number }[]>('SELECT COUNT(*) AS n FROM licenses');
    const result = await cli(['db:reset']);
    expect(result.code).toBe(2);
    expect(result.err).toContain(`db:reset only ever recreates notchos_dev; this configuration points at ${h.dbName}`);
    // The database it was pointed at is untouched.
    expect(await h.sql.query('SELECT COUNT(*) AS n FROM licenses')).toEqual(before);

    expect(() => assertResettable('notchos_app', 'development')).toThrow(/only ever recreates notchos_dev/);
    expect(() => assertResettable('notchos_dev_copy', 'development')).toThrow();
    expect(() => assertResettable('notchos_dev', 'production')).toThrow(/not available in production/);
    expect(() => assertResettable('notchos_dev', 'development')).not.toThrow();
    expect(() => assertResettable('notchos_dev', undefined)).not.toThrow();
  });
});

describe('the CLI itself', () => {
  it('lists every command in its help', async () => {
    const help = await cli(['--help']);
    expect(help.code).toBe(0);
    for (const name of [
      'license:create',
      'license:revoke',
      'license:reset-seat',
      'license:list',
      'db:migrate',
      'db:status',
      'db:reset',
    ]) {
      expect(help.out).toContain(name);
      expect(COMMANDS.map((command) => command.name)).toContain(name);
    }
    expect((await cli([])).code).toBe(2);
  });

  it('rejects an unknown command', async () => {
    const result = await cli(['license:delete-everything']);
    expect(result.code).toBe(2);
    expect(result.err).toContain('Unknown command: license:delete-everything');
  });

  it('names a missing setting without printing any value', async () => {
    const result = await cli(['license:list'], { ...env, DB_PASSWORD: undefined });
    expect(result).toEqual({ code: 1, out: '', err: 'license:list: DB_PASSWORD is not set' });

    const wrongPassword = await cli(['license:list'], { ...env, DB_PASSWORD: 'wrong-password-value' });
    expect(wrongPassword.code).toBe(1);
    expect(wrongPassword.err).toContain('license:list failed:');
    expect(wrongPassword.err).not.toContain('wrong-password-value');
    expect(wrongPassword.err).not.toContain(h.settings.api.password);
  });
});
