// Throwaway test databases.
//
// Two database users exist for the tests (created by scripts/dev-db.sh):
//   notchos_test_admin  may create and drop databases named notchos_test_* and nothing else
//   notchos_test_api    may only SELECT / INSERT / UPDATE / DELETE in those databases;
//                       the application under test runs as this user, like in production
// Their credentials are in ~/.notchos-dev/env/test.env (or NOTCHOS_TEST_ENV_FILE).

import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import type { Connection } from 'mariadb';
import type { ConnectionSettings } from '../../src/db/pool.ts';
import { openConnection, quoteDatabaseName } from '../../src/db/pool.ts';

export interface TestDbSettings {
  host: string;
  port: number;
  admin: { user: string; password: string };
  api: { user: string; password: string };
}

const TEST_DB_PREFIX = 'notchos_test_';
/** Leftovers of a crashed run are dropped once they are this old. */
const STALE_AFTER_SEC = 3600;

export function loadTestDbSettings(): TestDbSettings {
  const file = process.env.NOTCHOS_TEST_ENV_FILE ?? join(homedir(), '.notchos-dev', 'env', 'test.env');
  const fromFile = existsSync(file) ? parseEnv(readFileSync(file, 'utf8')) : {};
  const get = (name: string): string => {
    const value = process.env[name] ?? fromFile[name];
    if (value === undefined || value === '') {
      throw new Error(
        `${name} is not set. The tests need the private MariaDB and its test users: ` +
          `run scripts/dev-db.sh start (it writes ${file}).`,
      );
    }
    return value;
  };
  return {
    host: get('TEST_DB_HOST'),
    port: Number(get('TEST_DB_PORT')),
    admin: { user: get('TEST_DB_ADMIN_USER'), password: get('TEST_DB_ADMIN_PASSWORD') },
    api: { user: get('TEST_DB_API_USER'), password: get('TEST_DB_API_PASSWORD') },
  };
}

export function adminSettings(settings: TestDbSettings, database?: string): ConnectionSettings {
  return { host: settings.host, port: settings.port, ...settings.admin, database };
}

export function apiSettings(settings: TestDbSettings, database: string): ConnectionSettings & { database: string } {
  return { host: settings.host, port: settings.port, ...settings.api, database };
}

/** A fresh name: notchos_test_<unix seconds>_<random>. */
export function newTestDatabaseName(): string {
  return `${TEST_DB_PREFIX}${Math.floor(Date.now() / 1000)}_${randomBytes(5).toString('hex')}`;
}

function assertTestDatabaseName(name: string): void {
  if (!/^notchos_test_[a-z0-9_]{1,40}$/.test(name)) {
    throw new Error(`not a test database name: ${name}`);
  }
}

export async function createTestDatabase(settings: TestDbSettings, name: string): Promise<void> {
  assertTestDatabaseName(name);
  const conn = await openConnection(adminSettings(settings));
  try {
    await conn.query(
      `CREATE DATABASE ${quoteDatabaseName(name)} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    );
  } finally {
    await conn.end();
  }
}

export async function dropTestDatabase(settings: TestDbSettings, name: string): Promise<void> {
  assertTestDatabaseName(name);
  const conn = await openConnection(adminSettings(settings));
  try {
    await conn.query(`DROP DATABASE IF EXISTS ${quoteDatabaseName(name)}`);
  } finally {
    await conn.end();
  }
}

async function listTestDatabases(conn: Connection): Promise<string[]> {
  const rows = await conn.query<{ name: string }[]>(
    'SELECT schema_name AS name FROM information_schema.schemata WHERE schema_name LIKE ?',
    ['notchos\\_test\\_%'],
  );
  return rows.map((row) => row.name);
}

/** Drop test databases left behind by a run that crashed more than an hour ago. */
export async function dropStaleTestDatabases(settings: TestDbSettings): Promise<string[]> {
  const conn = await openConnection(adminSettings(settings));
  const dropped: string[] = [];
  try {
    const nowSec = Math.floor(Date.now() / 1000);
    for (const name of await listTestDatabases(conn)) {
      const match = /^notchos_test_(\d{9,11})_[a-z0-9]+$/.exec(name);
      if (match === null || nowSec - Number(match[1]) < STALE_AFTER_SEC) continue;
      await conn.query(`DROP DATABASE IF EXISTS ${quoteDatabaseName(name)}`);
      dropped.push(name);
    }
  } finally {
    await conn.end();
  }
  return dropped;
}
