// db:migrate, db:status, db:reset
//
// db:migrate and db:reset connect as the migration user (DB_MIGRATE_USER), the only user
// allowed to change the schema. Its credentials come from their own env file and are
// never given to the running API. db:status only reads, with the API's own user.

import {
  migrationsDir,
  parseConfig,
  parseDbTarget,
  parseMigrateCredentials,
  readEnv,
  readMigrateEnv,
} from '../../config.ts';
import { migrate, migrationStatus } from '../../db/migrate.ts';
import { checkConnection, openConnection, openPool, quoteDatabaseName } from '../../db/pool.ts';
import { systemClock, toIso } from '../../lib/time.ts';
import type { CliIo, Command } from '../command.ts';
import { printTable, UsageError } from '../command.ts';

/** The only database db:reset will ever drop. */
export const RESETTABLE_DATABASE = 'notchos_dev';

/** Throws unless dropping and recreating this database is allowed. */
export function assertResettable(database: string, nodeEnv: string | undefined): void {
  if (nodeEnv === 'production') {
    throw new UsageError('db:reset is not available in production');
  }
  if (database !== RESETTABLE_DATABASE) {
    throw new UsageError(
      `db:reset only ever recreates ${RESETTABLE_DATABASE}; this configuration points at ${database}`,
    );
  }
}

function noArguments(args: string[], name: string): void {
  if (args.length > 0) throw new UsageError(`${name} takes no arguments`);
}

const migrateCommand: Command = {
  name: 'db:migrate',
  summary: 'Apply the pending SQL migrations from db/migrations',
  usage: '',
  async run(args: string[], io: CliIo): Promise<number> {
    noArguments(args, 'db:migrate');
    const values = readMigrateEnv(io.env);
    const target = parseDbTarget(values);
    const applied = await migrate({
      connection: { ...target, ...parseMigrateCredentials(values) },
      dir: migrationsDir(values),
      now: systemClock.now,
      log: (message) => io.out(`${target.database}: ${message}`),
    });
    io.out(
      applied.length === 0
        ? `${target.database}: schema is up to date`
        : `${target.database}: ${applied.length} migration(s) applied`,
    );
    return 0;
  },
};

const statusCommand: Command = {
  name: 'db:status',
  summary: 'Show which migrations are applied and which are pending',
  usage: '',
  async run(args: string[], io: CliIo): Promise<number> {
    noArguments(args, 'db:status');
    const config = parseConfig(readEnv(io.env));
    await checkConnection(config.db);
    const db = openPool(config.db);
    try {
      const plan = await migrationStatus(db, config.migrationsDir);
      io.out(`database ${config.db.database} at ${config.db.host}:${config.db.port}`);
      printTable(
        io,
        ['MIGRATION', 'STATE', 'APPLIED AT'],
        [
          ...plan.applied.map((row) => [row.name, 'applied', toIso(row.applied_at)]),
          ...plan.pending.map((file) => [file.name, 'pending', '-']),
        ],
      );
      return plan.pending.length === 0 ? 0 : 1;
    } finally {
      await db.end();
    }
  },
};

const resetCommand: Command = {
  name: 'db:reset',
  summary: `Drop and recreate the ${RESETTABLE_DATABASE} database only, then apply all migrations`,
  usage: '',
  async run(args: string[], io: CliIo): Promise<number> {
    noArguments(args, 'db:reset');
    const values = readMigrateEnv(io.env);
    const target = parseDbTarget(values);
    assertResettable(target.database, values.NODE_ENV);
    const credentials = parseMigrateCredentials(values);

    // The name is the constant checked above; the migration user has rights on this one
    // database only, so no other database and no data dir can be affected.
    const name = quoteDatabaseName(RESETTABLE_DATABASE);
    const conn = await openConnection({ host: target.host, port: target.port, ...credentials });
    try {
      await conn.query(`DROP DATABASE IF EXISTS ${name}`);
      await conn.query(`CREATE DATABASE ${name} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    } finally {
      await conn.end();
    }
    io.out(`${target.database}: dropped and recreated (empty)`);

    const applied = await migrate({
      connection: { ...target, ...credentials },
      dir: migrationsDir(values),
      now: systemClock.now,
      log: (message) => io.out(`${target.database}: ${message}`),
    });
    io.out(`${target.database}: ${applied.length} migration(s) applied`);
    return 0;
  },
};

export const dbCommands: Command[] = [migrateCommand, statusCommand, resetCommand];
