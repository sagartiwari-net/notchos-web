// A small migration runner.
//
//   * Migrations are plain SQL files in db/migrations named NNN_description.sql and are
//     applied in numeric order, each exactly once.
//   * What has been applied is recorded in the table schema_migrations together with a
//     SHA-256 of the file. An applied file that changes afterwards is an error: applied
//     migrations are never edited, changes go into a new file.
//   * It connects as the migration user (the only user allowed to change the schema) and
//     holds a named lock, so two runs cannot overlap.
//   * MariaDB commits DDL implicitly, so a file is not atomic. Files should therefore be
//     written so that running them again is harmless (CREATE TABLE IF NOT EXISTS ...).

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ConnectionSettings, Queryable } from './pool.ts';
import { isMissingTableError, openConnection, selectOne, selectRows, write } from './pool.ts';

export class MigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MigrationError';
  }
}

export interface MigrationFile {
  version: number;
  name: string;
  checksum: string;
  sql: string;
}

export interface AppliedMigration {
  version: number;
  name: string;
  checksum: string;
  applied_at: Date;
}

export interface MigrationPlan {
  applied: AppliedMigration[];
  pending: MigrationFile[];
}

const FILE_NAME = /^(\d{3})_[a-z0-9_]+\.sql$/;

const CREATE_BOOKKEEPING_TABLE = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version    INT UNSIGNED NOT NULL,
    name       VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    checksum   CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    applied_at DATETIME NOT NULL,
    PRIMARY KEY (version)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`;

/** Read and order the migration files of a directory. */
export function readMigrationFiles(dir: string): MigrationFile[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    throw new MigrationError(`migrations directory not found: ${dir}`);
  }

  const files: MigrationFile[] = [];
  for (const name of names) {
    if (!name.endsWith('.sql')) continue;
    const match = FILE_NAME.exec(name);
    if (!match) {
      throw new MigrationError(`migration file names look like 002_add_something.sql, got: ${name}`);
    }
    const sql = readFileSync(join(dir, name), 'utf8');
    files.push({
      version: Number(match[1]),
      name,
      checksum: createHash('sha256').update(sql).digest('hex'),
      sql,
    });
  }
  if (files.length === 0) throw new MigrationError(`no migration files in ${dir}`);

  files.sort((a, b) => a.version - b.version);
  for (let i = 1; i < files.length; i++) {
    const previous = files[i - 1]!;
    const current = files[i]!;
    if (previous.version === current.version) {
      throw new MigrationError(`two migrations share the number ${current.version}: ${previous.name}, ${current.name}`);
    }
  }
  return files;
}

/** Compare the files with what the database has applied; throws if they contradict each other. */
export function planMigrations(files: MigrationFile[], applied: AppliedMigration[]): MigrationPlan {
  const byVersion = new Map(files.map((file) => [file.version, file]));
  let newestApplied = 0;
  for (const row of applied) {
    const file = byVersion.get(row.version);
    if (file === undefined) {
      throw new MigrationError(
        `the database has ${row.name} applied, but that file is not in the migrations directory ` +
          '(this code is older than the database)',
      );
    }
    if (file.checksum !== row.checksum) {
      throw new MigrationError(
        `${file.name} was changed after it was applied to this database. ` +
          'Applied migrations are never edited: put the change into a new migration file.',
      );
    }
    newestApplied = Math.max(newestApplied, row.version);
  }

  const done = new Set(applied.map((row) => row.version));
  const pending = files.filter((file) => !done.has(file.version));
  for (const file of pending) {
    if (file.version < newestApplied) {
      throw new MigrationError(
        `${file.name} is numbered below the newest applied migration (${newestApplied}). ` +
          'Give new migrations the next free number.',
      );
    }
  }
  return { applied, pending };
}

/** The applied migrations, oldest first. An empty list when nothing was ever applied. */
export async function readAppliedMigrations(q: Queryable): Promise<AppliedMigration[]> {
  try {
    return await selectRows<AppliedMigration>(
      q,
      'SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version',
    );
  } catch (err) {
    if (isMissingTableError(err)) return [];
    throw err;
  }
}

/** What is applied and what is pending. Read-only: works with the API's own database user. */
export async function migrationStatus(q: Queryable, dir: string): Promise<MigrationPlan> {
  return planMigrations(readMigrationFiles(dir), await readAppliedMigrations(q));
}

export interface MigrateOptions {
  /** The migration user and the database to migrate. */
  connection: ConnectionSettings & { database: string };
  dir: string;
  now: () => Date;
  log?: (message: string) => void;
}

/** Apply every pending migration. Returns the names of the files that were applied. */
export async function migrate(options: MigrateOptions): Promise<string[]> {
  const files = readMigrationFiles(options.dir);
  const log = options.log ?? (() => {});
  const lockName = `notchos_migrate:${options.connection.database}`;

  const conn = await openConnection(options.connection, { multipleStatements: true });
  try {
    const lock = await selectOne<{ locked: number | null }>(conn, 'SELECT GET_LOCK(?, 30) AS locked', [lockName]);
    if (lock?.locked !== 1) {
      throw new MigrationError('another migration run holds the lock; try again when it has finished');
    }

    await conn.query(CREATE_BOOKKEEPING_TABLE);
    const plan = planMigrations(files, await readAppliedMigrations(conn));

    const appliedNow: string[] = [];
    for (const file of plan.pending) {
      // The file is trusted SQL from this repository; it holds several statements and no parameters.
      await conn.query(file.sql);
      await write(conn, 'INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)', [
        file.version,
        file.name,
        file.checksum,
        options.now(),
      ]);
      appliedNow.push(file.name);
      log(`applied ${file.name}`);
    }
    await conn.query('SELECT RELEASE_LOCK(?)', [lockName]);
    return appliedNow;
  } finally {
    await conn.end();
  }
}
