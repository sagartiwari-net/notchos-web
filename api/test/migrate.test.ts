// The migration runner, the schema it creates, and the database rules the code relies on:
// least-privilege users, UTC sessions, strict mode, parameters kept out of error messages.

import { copyFileSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Connection } from 'mariadb';
import { SqlError } from 'mariadb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  migrate,
  MigrationError,
  migrationStatus,
  planMigrations,
  readAppliedMigrations,
  readMigrationFiles,
} from '../src/db/migrate.ts';
import { openConnection } from '../src/db/pool.ts';
import { MIGRATIONS_DIR } from './helpers/harness.ts';
import {
  adminSettings,
  apiSettings,
  createTestDatabase,
  dropTestDatabase,
  loadTestDbSettings,
  newTestDatabaseName,
} from './helpers/test-db.ts';

const settings = loadTestDbSettings();
const dbName = newTestDatabaseName();
const scratch = mkdtempSync(join(tmpdir(), 'notchos-migrate-test-'));
const NOW = new Date('2026-11-10T08:00:00Z');

let admin: Connection;
let api: Connection;

/** A private copy of the real migrations, so tests can add and edit files. */
function copyOfMigrations(label: string): string {
  const target = mkdtempSync(join(scratch, `${label}-`));
  for (const file of readdirSync(MIGRATIONS_DIR)) copyFileSync(join(MIGRATIONS_DIR, file), join(target, file));
  return target;
}

function run(dir: string, log: string[] = []): Promise<string[]> {
  return migrate({
    connection: { ...adminSettings(settings), database: dbName },
    dir,
    now: () => NOW,
    log: (line) => log.push(line),
  });
}

async function sqlError(action: () => Promise<unknown>): Promise<SqlError> {
  try {
    await action();
  } catch (err) {
    expect(err).toBeInstanceOf(SqlError);
    return err as SqlError;
  }
  throw new Error('expected the statement to fail');
}

beforeAll(async () => {
  await createTestDatabase(settings, dbName);
  admin = await openConnection(adminSettings(settings, dbName));
  api = await openConnection(apiSettings(settings, dbName));
});

afterAll(async () => {
  await admin.end();
  await api.end();
  await dropTestDatabase(settings, dbName);
  rmSync(scratch, { recursive: true, force: true });
});

describe('migration runner', () => {
  it('applies every pending migration to an empty database and records them', async () => {
    const files = readMigrationFiles(MIGRATIONS_DIR);
    expect((await migrationStatus(api, MIGRATIONS_DIR)).pending.map((file) => file.name)).toEqual(
      files.map((file) => file.name),
    );

    const log: string[] = [];
    expect(await run(MIGRATIONS_DIR, log)).toEqual(files.map((file) => file.name));
    expect(log).toEqual(files.map((file) => `applied ${file.name}`));

    const applied = await readAppliedMigrations(api);
    expect(applied).toEqual(
      files.map((file) => ({
        version: file.version,
        name: file.name,
        checksum: file.checksum,
        applied_at: NOW,
      })),
    );
    expect((await migrationStatus(api, MIGRATIONS_DIR)).pending).toEqual([]);
  });

  it('does nothing when run again', async () => {
    expect(await run(MIGRATIONS_DIR)).toEqual([]);
    expect(await readAppliedMigrations(api)).toHaveLength(readMigrationFiles(MIGRATIONS_DIR).length);
  });

  it('applies a new file exactly once, in number order', async () => {
    const dir = copyOfMigrations('next');
    writeFileSync(join(dir, '004_second.sql'), 'CREATE TABLE IF NOT EXISTS t_second (id INT PRIMARY KEY);\n');
    writeFileSync(
      join(dir, '003_first.sql'),
      'CREATE TABLE IF NOT EXISTS t_first (id INT PRIMARY KEY);\nINSERT INTO t_first (id) VALUES (1), (2);\n',
    );

    expect(await run(dir)).toEqual(['003_first.sql', '004_second.sql']);
    expect(await run(dir)).toEqual([]);
    expect(await admin.query('SELECT COUNT(*) AS n FROM t_first')).toEqual([{ n: 2 }]);
    expect((await readAppliedMigrations(api)).map((row) => row.version)).toEqual([1, 2, 3, 4]);
  });

  it('refuses to continue when an applied migration was edited', async () => {
    const dir = copyOfMigrations('edited');
    const second = readMigrationFiles(MIGRATIONS_DIR).find((file) => file.version === 2);
    expect(second).toBeDefined();
    writeFileSync(join(dir, second!.name), `${second!.sql}\n-- edited\n`);
    writeFileSync(join(dir, '005_never.sql'), 'CREATE TABLE t_never (id INT PRIMARY KEY);\n');

    await expect(run(dir)).rejects.toThrow(MigrationError);
    await expect(run(dir)).rejects.toThrow(new RegExp(`${second!.name.replace('.', '\\.')} was changed after it was applied`));
    // Nothing after the problem was applied.
    expect((await readAppliedMigrations(api)).map((row) => row.version)).toEqual([1, 2, 3, 4]);
    await expect(migrationStatus(api, dir)).rejects.toThrow(/changed after it was applied/);
  });

  it('refuses a database that is ahead of the code, and numbers that go backwards', async () => {
    // The database has 003 and 004 from the previous test; the real folder only knows 001–002.
    await expect(migrationStatus(api, MIGRATIONS_DIR)).rejects.toThrow(/this code is older than the database/);

    const [first] = readMigrationFiles(MIGRATIONS_DIR);
    const applied = [
      { version: 1, name: first!.name, checksum: first!.checksum, applied_at: NOW },
      { version: 5, name: '005_later.sql', checksum: 'x'.repeat(64), applied_at: NOW },
    ];
    const files = [
      first!,
      { version: 3, name: '003_late_arrival.sql', checksum: 'y'.repeat(64), sql: '' },
      { version: 5, name: '005_later.sql', checksum: 'x'.repeat(64), sql: '' },
    ];
    expect(() => planMigrations(files, applied)).toThrow(/003_late_arrival\.sql is numbered below/);
  });

  it('checks the file names in the migrations folder', () => {
    const bad = mkdtempSync(join(scratch, 'names-'));
    writeFileSync(join(bad, '001_init.sql'), 'SELECT 1;');
    writeFileSync(join(bad, 'notes.txt'), 'not a migration');
    expect(readMigrationFiles(bad).map((file) => file.name)).toEqual(['001_init.sql']);

    writeFileSync(join(bad, '2_wrong.sql'), 'SELECT 1;');
    expect(() => readMigrationFiles(bad)).toThrow(/look like 002_add_something\.sql/);
    rmSync(join(bad, '2_wrong.sql'));

    writeFileSync(join(bad, '001_again.sql'), 'SELECT 1;');
    expect(() => readMigrationFiles(bad)).toThrow(/share the number 1/);

    expect(() => readMigrationFiles(join(scratch, 'does-not-exist'))).toThrow(/not found/);
    expect(() => readMigrationFiles(mkdtempSync(join(scratch, 'empty-')))).toThrow(/no migration files/);
  });

  it('lets only one run work at a time', async () => {
    const name = newTestDatabaseName();
    await createTestDatabase(settings, name);
    try {
      const options = { connection: { ...adminSettings(settings), database: name }, dir: MIGRATIONS_DIR, now: () => NOW };
      const results = await Promise.all([migrate(options), migrate(options), migrate(options)]);
      expect(results.flat()).toEqual(readMigrationFiles(MIGRATIONS_DIR).map((file) => file.name));
    } finally {
      await dropTestDatabase(settings, name);
    }
  });
});

describe('schema of 001_init.sql (WEB plan section 4)', () => {
  it('creates every table', async () => {
    const rows = await admin.query<{ name: string; engine: string; collation: string }[]>(
      `SELECT table_name AS name, engine, table_collation AS collation
         FROM information_schema.tables WHERE table_schema = ? ORDER BY table_name`,
      [dbName],
    );
    const planned = [
      'activations',
      'admin_sessions',
      'admin_users',
      'audit_log',
      'checkouts',
      'email_log',
      'events',
      'licenses',
      'payments',
      'seat_moves',
      'settings',
      'trials',
      'trial_leads',
      'webhook_events',
    ];
    const tables = rows.filter((row) => !row.name.startsWith('t_') && row.name !== 'schema_migrations');
    expect(tables.map((row) => row.name)).toEqual(planned);
    for (const table of tables) {
      expect(table.engine, table.name).toBe('InnoDB');
      expect(table.collation, table.name).toBe('utf8mb4_unicode_ci');
    }
  });

  it('has the planned columns', async () => {
    const rows = await admin.query<{ t: string; c: string }[]>(
      `SELECT table_name AS t, column_name AS c FROM information_schema.columns
        WHERE table_schema = ? ORDER BY table_name, ordinal_position`,
      [dbName],
    );
    const columns: Record<string, string[]> = {};
    for (const row of rows) (columns[row.t] ??= []).push(row.c);

    expect(columns.licenses).toEqual([
      'id', 'key_hash', 'key_enc', 'key_hint', 'email', 'payer_id', 'plan', 'status', 'max_devices',
      'period_end', 'expires_at', 'auto_renew', 'paypal_subscription_id', 'transfers_used', 'source',
      'note', 'created_at', 'updated_at',
    ]);
    expect(columns.activations).toEqual([
      'id', 'license_id', 'device_id', 'device_name', 'app_version', 'activated_at', 'last_seen_at', 'deactivated_at',
    ]);
    expect(columns.trials).toEqual(['device_id', 'email', 'started_at', 'expires_at', 'app_version', 'ip', 'lead_id']);
    expect(columns.trial_leads).toEqual([
      'id',
      'email',
      'status',
      'download_sent_at',
      'resend_count',
      'converted_trial_device_id',
      'converted_license_id',
      'ip',
      'user_agent',
      'created_at',
      'updated_at',
    ]);
    expect(columns.seat_moves).toEqual([
      'id',
      'license_id',
      'email',
      'key_hint',
      'from_device_id',
      'from_device_name',
      'to_device_id',
      'to_device_name',
      'reason',
      'transfers_used_after',
      'transfers_left_after',
      'actor',
      'admin_id',
      'ip',
      'detail',
      'created_at',
    ]);
    expect(columns.checkouts).toEqual(['paypal_order_id', 'plan', 'amount', 'currency', 'status', 'created_at']);
    expect(columns.payments).toEqual([
      'id', 'license_id', 'kind', 'paypal_id', 'amount', 'currency', 'payer_email', 'payer_id', 'status',
      'raw_json', 'created_at',
    ]);
    expect(columns.webhook_events).toEqual(['paypal_event_id', 'event_type', 'verified', 'result', 'raw_json', 'received_at']);
    expect(columns.email_log).toEqual(['id', 'license_id', 'to_email', 'template', 'status', 'attempts', 'error', 'created_at']);
    expect(columns.events).toEqual(['id', 'license_id', 'device_id', 'type', 'detail', 'ip', 'created_at']);
    expect(columns.admin_users).toEqual(['id', 'username', 'password_hash', 'totp_secret_enc', 'last_login_at']);
    expect(columns.admin_sessions).toEqual(['id_hash', 'admin_id', 'ip', 'user_agent', 'created_at', 'expires_at']);
    expect(columns.audit_log).toEqual(['id', 'admin_id', 'action', 'target', 'detail', 'ip', 'created_at']);
    expect(columns.settings).toEqual(['name', 'value']);
  });

  it('seeds the settings that have a default in the plan', async () => {
    expect(await admin.query('SELECT name, value FROM settings ORDER BY name')).toEqual([
      { name: 'renewal_buffer_hours', value: '24' },
      { name: 'transfer_limit', value: '2' },
      { name: 'trial_days', value: '7' },
    ]);
  });

  it('enforces the uniqueness rules', async () => {
    const insertLicense = (keyHash: string, subscription: string | null) =>
      admin.query(
        `INSERT INTO licenses (key_hash, key_enc, key_hint, email, plan, source, paypal_subscription_id)
         VALUES (?, 'v1.x.y.z', 'ABCD', 'a@example.com', 'lifetime', 'manual', ?)`,
        [keyHash, subscription],
      );
    await insertLicense('a'.repeat(64), 'I-SUB1');
    expect((await sqlError(() => insertLicense('a'.repeat(64), null))).errno).toBe(1062);
    expect((await sqlError(() => insertLicense('b'.repeat(64), 'I-SUB1'))).errno).toBe(1062);
    // Many licenses without a subscription are fine.
    await insertLicense('c'.repeat(64), null);
    await insertLicense('d'.repeat(64), null);

    await admin.query("INSERT INTO trials (device_id, started_at, expires_at) VALUES ('dev-1', ?, ?)", [NOW, NOW]);
    expect(
      (await sqlError(() => admin.query("INSERT INTO trials (device_id, started_at, expires_at) VALUES ('dev-1', ?, ?)", [NOW, NOW]))).errno,
    ).toBe(1062);
  });

  it('keeps plan and expiry consistent: lifetime has no date, monthly has one', async () => {
    const insert = (plan: string, expires: Date | null) =>
      admin.query(
        `INSERT INTO licenses (key_hash, key_enc, key_hint, email, plan, source, expires_at)
         VALUES (?, 'v1.x.y.z', 'ABCD', 'a@example.com', ?, 'manual', ?)`,
        [`${plan}-${expires === null ? 'null' : 'date'}`.padEnd(64, '0'), plan, expires],
      );
    await insert('lifetime', null);
    await insert('monthly', NOW);
    expect((await sqlError(() => insert('lifetime', NOW))).message).toMatch(/ck_licenses_plan_expiry/);
    expect((await sqlError(() => insert('monthly', null))).message).toMatch(/ck_licenses_plan_expiry/);
    await sqlError(() => insert('yearly', NOW));
  });

  it('ties seats, events and payments to an existing license', async () => {
    const error = await sqlError(() =>
      admin.query(
        "INSERT INTO activations (license_id, device_id, activated_at, last_seen_at) VALUES (999999, 'dev', ?, ?)",
        [NOW, NOW],
      ),
    );
    expect(error.errno).toBe(1452);
    const [license] = await admin.query<{ id: number }[]>('SELECT id FROM licenses LIMIT 1');
    await admin.query(
      "INSERT INTO activations (license_id, device_id, activated_at, last_seen_at) VALUES (?, 'dev', ?, ?)",
      [license!.id, NOW, NOW],
    );
    // A license with history cannot be deleted by accident.
    expect((await sqlError(() => admin.query('DELETE FROM licenses WHERE id = ?', [license!.id]))).errno).toBe(1451);
  });
});

describe('database users', () => {
  it('lets the API user read and write rows', async () => {
    await api.query("INSERT INTO settings (name, value) VALUES ('probe', '1')");
    await api.query("UPDATE settings SET value = '2' WHERE name = 'probe'");
    expect(await api.query("SELECT value FROM settings WHERE name = 'probe'")).toEqual([{ value: '2' }]);
    await api.query("DELETE FROM settings WHERE name = 'probe'");
  });

  it('does not let the API user change the schema or leave its database', async () => {
    const denied = [
      'CREATE TABLE t_api (id INT PRIMARY KEY)',
      'DROP TABLE settings',
      'ALTER TABLE settings ADD COLUMN extra INT',
      'CREATE INDEX ix_probe ON settings (value(10))',
      'TRUNCATE TABLE events',
      `DROP DATABASE \`${dbName}\``,
      'CREATE DATABASE notchos_test_made_by_api',
      'SELECT COUNT(*) FROM notchos_dev.licenses',
      'SELECT COUNT(*) FROM mysql.global_priv',
      `SELECT 1 INTO OUTFILE '${join(scratch, 'outfile-probe.txt')}'`,
    ];
    for (const statement of denied) {
      const error = await sqlError(() => api.query(statement));
      expect([1044, 1045, 1142, 1227, 1370], `${statement} -> ${error.errno}`).toContain(error.errno);
    }
  });

  it('does not let the test admin touch anything outside notchos_test_*', async () => {
    for (const statement of ['CREATE DATABASE notchos_other', 'CREATE DATABASE notchosXtest_1', 'SELECT COUNT(*) FROM notchos_dev.licenses']) {
      const error = await sqlError(() => admin.query(statement));
      expect([1044, 1142], statement).toContain(error.errno);
    }
  });
});

describe('connection rules', () => {
  it('runs every session in UTC with a strict sql_mode', async () => {
    const [row] = await api.query<{ tz: string; mode: string; charset: string; lock_wait: number }[]>(
      `SELECT @@session.time_zone AS tz, @@session.sql_mode AS mode,
              @@character_set_connection AS charset, @@session.innodb_lock_wait_timeout AS lock_wait`,
    );
    expect(row!.tz).toBe('+00:00');
    expect(row!.mode).toContain('STRICT_TRANS_TABLES');
    expect(row!.charset).toBe('utf8mb4');
    // A request waits at most ten seconds for a row lock, not the server's 50.
    expect(Number(row!.lock_wait)).toBe(10);
  });

  it('stores and returns dates as UTC, whatever time zone this machine is in', async () => {
    // Loading the database module put this process into UTC (the driver formats Date
    // parameters with the process time zone).
    expect(process.env.TZ).toBe('UTC');
    expect(new Date(2026, 6, 4, 12).getTimezoneOffset()).toBe(0);

    const instant = new Date('2026-07-04T23:30:15Z');
    // Written once through each protocol the driver has: text (query) and binary (execute).
    await admin.query("INSERT INTO trials (device_id, started_at, expires_at) VALUES ('tz-text', ?, ?)", [instant, instant]);
    await api.execute("INSERT INTO trials (device_id, started_at, expires_at) VALUES ('tz-binary', ?, ?)", [instant, instant]);

    const select = `SELECT device_id, started_at, DATE_FORMAT(started_at, '%Y-%m-%dT%H:%i:%sZ') AS as_text,
                           UNIX_TIMESTAMP(started_at) AS as_epoch
                      FROM trials WHERE device_id IN ('tz-text', 'tz-binary') ORDER BY device_id`;
    type Row = { device_id: string; started_at: Date; as_text: string; as_epoch: number };
    for (const rows of [await api.query<Row[]>(select), await api.execute<Row[]>(select)]) {
      expect(rows.map((row) => row.device_id)).toEqual(['tz-binary', 'tz-text']);
      for (const row of rows) {
        // What the database holds is the UTC wall-clock time ...
        expect(row.as_text).toBe('2026-07-04T23:30:15Z');
        expect(Number(row.as_epoch)).toBe(instant.getTime() / 1000);
        // ... and it comes back as the same instant.
        expect(row.started_at).toEqual(instant);
      }
    }
  });

  it('gives CURRENT_TIMESTAMP column defaults in UTC as well', async () => {
    await api.execute("INSERT INTO events (type, detail) VALUES ('trial', 'default-probe')");
    const [row] = await api.execute<{ created_at: Date }[]>(
      "SELECT created_at FROM events WHERE detail = 'default-probe'",
    );
    expect(Math.abs(row!.created_at.getTime() - Date.now())).toBeLessThan(5_000);
  });

  it('fails instead of silently cutting a value that is too long', async () => {
    const error = await sqlError(() =>
      api.query("INSERT INTO trials (device_id, started_at, expires_at, app_version) VALUES ('long-probe', ?, ?, ?)", [
        NOW,
        NOW,
        'v'.repeat(33),
      ]),
    );
    expect(error.errno).toBe(1406);
  });

  it('keeps parameter values out of error messages', async () => {
    const marker = 'PARAMETER-VALUE-THAT-MUST-NOT-LEAK';
    const error = await sqlError(() => api.execute('SELECT * FROM no_such_table WHERE a = ?', [marker]));
    expect(error.errno).toBe(1146);
    expect(`${error.message} ${error.sql ?? ''} ${String(error.stack)}`).not.toContain(marker);
  });

  it('runs one statement per call: a second statement is a syntax error', async () => {
    const error = await sqlError(() => api.query("SELECT 1; DELETE FROM settings WHERE name <> ''"));
    expect(error.errno).toBe(1064);
    expect(await admin.query('SELECT COUNT(*) AS n FROM settings')).toEqual([{ n: 3 }]);
  });
});
