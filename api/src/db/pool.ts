// Database access: one connection pool, one transaction helper.
//
// Rules for every query in this code base:
//   * Values only ever travel as parameters (? placeholders, server-side prepared
//     statements through execute()). SQL text is never built from input.
//   * Dates are JavaScript Date objects in, Date objects out, and the database holds UTC.
//     The Node process and every database session run in UTC, with a strict sql_mode,
//     whatever the defaults of the machine and of the server are.
//   * A license's seats are only read or written while the licenses row is locked
//     (SELECT ... FOR UPDATE inside withTransaction).

import { createConnection, createPool, SqlError } from 'mariadb';
import type { Connection, ConnectionConfig, Pool, PoolConnection } from 'mariadb';

// The MariaDB driver converts between JavaScript Date and DATETIME using the time zone
// of the Node process (its encoder formats with getHours() and friends; the driver's
// `timezone` option only sets the session time zone on the server). The database holds
// UTC, so every process that talks to the database runs in UTC. Loading this module
// makes it so, and assertUtcProcess() refuses to open a connection if that did not work,
// instead of storing local times without anyone noticing.
process.env.TZ = 'UTC';

function assertUtcProcess(): void {
  // January and July, so a zone that is UTC only outside summer time is caught too.
  if (new Date(2026, 0, 1).getTimezoneOffset() !== 0 || new Date(2026, 6, 1).getTimezoneOffset() !== 0) {
    throw new Error('the process time zone is not UTC; start Node with TZ=UTC');
  }
}

export type Db = Pool;
export type Tx = PoolConnection;

/** Anything that can run a parameterised statement: the pool, or a transaction. */
export interface Queryable {
  execute<T = unknown>(sql: string, values?: unknown[]): Promise<T>;
}

export interface WriteResult {
  affectedRows: number;
  insertId: number;
}

export interface ConnectionSettings {
  host: string;
  port: number;
  user: string;
  password: string;
  database?: string;
}

const SESSION_SQL_MODE =
  'STRICT_TRANS_TABLES,NO_ZERO_DATE,NO_ZERO_IN_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION';
const LOCK_WAIT_TIMEOUT_SEC = 10;

// The driver reports trouble it recovers from by itself (for example a pooled connection
// that could not be opened) as a warning. By default it goes to stderr; the server sends
// it to its structured log instead. These messages carry no parameters and no passwords.
let driverWarning: (message: string) => void = (message) => console.error(`[mariadb] ${message}`);

export function onDriverWarning(handler: (message: string) => void): void {
  driverWarning = handler;
}

/** Options shared by every connection, so behaviour is the same in dev, tests and production. */
export function connectionOptions(settings: ConnectionSettings): ConnectionConfig {
  return {
    host: settings.host,
    port: settings.port,
    user: settings.user,
    password: settings.password,
    database: settings.database,
    charset: 'utf8mb4',
    collation: 'UTF8MB4_UNICODE_CI',
    // Makes the driver run SET time_zone = '+00:00' on every new session, so NOW() and
    // column defaults are UTC too. (Date values themselves follow the process time zone,
    // which is UTC: see the top of this file.)
    timezone: 'Z',
    initSql: [
      `SET SESSION sql_mode = '${SESSION_SQL_MODE}'`,
      // A request never waits longer than this for a row lock (the server default is 50 s).
      `SET SESSION innodb_lock_wait_timeout = ${LOCK_WAIT_TIMEOUT_SEC}`,
    ],
    dateStrings: false,
    bigIntAsNumber: true,
    insertIdAsNumber: true,
    decimalAsNumber: false,
    checkDuplicate: true,
    multipleStatements: false,
    permitLocalInfile: false,
    allowPublicKeyRetrieval: false,
    // Errors raised by the driver carry the SQL text but never the parameter values.
    logParam: false,
    trace: false,
    logger: { warning: (message: unknown) => driverWarning(String(message)) },
    connectTimeout: 5_000,
  };
}

/**
 * Open and close one connection. Used before a pool is relied on: a wrong password or a
 * stopped server fails here at once and with the real reason, where a pool would retry
 * for ten seconds and then only report a timeout.
 */
export async function checkConnection(settings: ConnectionSettings): Promise<void> {
  const conn = await openConnection(settings);
  await conn.end();
}

export function openPool(settings: ConnectionSettings & { poolSize: number }): Db {
  assertUtcProcess();
  return createPool({
    ...connectionOptions(settings),
    connectionLimit: settings.poolSize,
    // Connections are opened as they are needed; two are kept ready.
    minimumIdle: Math.min(2, settings.poolSize),
    // How long a request waits for a free connection before it fails (database down, or
    // every connection busy).
    acquireTimeout: 5_000,
  });
}

/** One plain connection (migrations, db:reset, tests). The caller must end() it. */
export function openConnection(
  settings: ConnectionSettings,
  extra: Pick<ConnectionConfig, 'multipleStatements'> = {},
): Promise<Connection> {
  assertUtcProcess();
  return createConnection({ ...connectionOptions(settings), ...extra });
}

const ER_LOCK_DEADLOCK = 1213;
const MAX_TRANSACTION_ATTEMPTS = 3;

/**
 * Run `work` inside one transaction. Commits when it returns, rolls back when it throws.
 * A "refused" outcome (wrong state, limit reached) is a normal return value, so the event
 * that records the refusal is committed too.
 *
 * If InnoDB picks the transaction as a deadlock victim it has been rolled back completely,
 * and `work` is run again from the start (up to three attempts). `work` must therefore
 * derive everything from what it reads inside the transaction.
 */
export async function withTransaction<T>(db: Db, work: (tx: Tx) => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    const tx = await db.getConnection();
    try {
      await tx.beginTransaction();
      const result = await work(tx);
      await tx.commit();
      return result;
    } catch (err) {
      try {
        await tx.rollback();
      } catch {
        // The connection is broken; release() below discards it.
      }
      const deadlock = err instanceof SqlError && err.errno === ER_LOCK_DEADLOCK;
      if (!deadlock || attempt >= MAX_TRANSACTION_ATTEMPTS) throw err;
    } finally {
      await tx.release();
    }
  }
}

export async function selectRows<T>(q: Queryable, sql: string, values: unknown[] = []): Promise<T[]> {
  return q.execute<T[]>(sql, values);
}

export async function selectOne<T>(q: Queryable, sql: string, values: unknown[] = []): Promise<T | null> {
  const rows = await q.execute<T[]>(sql, values);
  return rows[0] ?? null;
}

export async function write(q: Queryable, sql: string, values: unknown[] = []): Promise<WriteResult> {
  const result = await q.execute<{ affectedRows: number; insertId: number | bigint }>(sql, values);
  return { affectedRows: result.affectedRows, insertId: Number(result.insertId) };
}

const ER_DUP_ENTRY = 1062;
const ER_NO_SUCH_TABLE = 1146;

export function isDuplicateKeyError(err: unknown): boolean {
  return err instanceof SqlError && err.errno === ER_DUP_ENTRY;
}

/** The unique index a duplicate-key error is about ('' if unnamed), or null for any other error. */
export function duplicateKeyIndex(err: unknown): string | null {
  if (!(err instanceof SqlError) || err.errno !== ER_DUP_ENTRY) return null;
  const match = /for key '([^']+)'/.exec(err.sqlMessage ?? '');
  return match ? match[1]! : '';
}

export function isMissingTableError(err: unknown): boolean {
  return err instanceof SqlError && err.errno === ER_NO_SUCH_TABLE;
}

/** Quote a database name for use in DDL. Only called with names this code base generates. */
export function quoteDatabaseName(name: string): string {
  if (!/^[A-Za-z0-9_]{1,64}$/.test(name)) {
    throw new Error('database name may only contain letters, digits and underscores');
  }
  return `\`${name}\``;
}
