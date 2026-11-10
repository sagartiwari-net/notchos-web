// A complete API on a throwaway database, for one test file.
//
//   const h = await createHarness();     // in beforeAll
//   ...                                  // h.post('/v1/activate', {...})
//   await h.close();                     // in afterAll: closes pools, drops the database
//
// The application runs as the DML-only database user, with an in-memory signing key, a
// random key-encryption secret and a clock the test controls.

import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import { connect } from 'node:net';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { Connection } from 'mariadb';
import { buildApp } from '../../src/app.ts';
import type { Config, RateLimitConfig } from '../../src/config.ts';
import type { AppContext } from '../../src/context.ts';
import { createAppContext } from '../../src/context.ts';
import type { TokenPayload } from '../../src/crypto/signing.ts';
import { createSigner, verifyToken } from '../../src/crypto/signing.ts';
import { migrate } from '../../src/db/migrate.ts';
import { openConnection, withTransaction } from '../../src/db/pool.ts';
import type { Clock } from '../../src/lib/time.ts';
import { addDays, truncateToSeconds } from '../../src/lib/time.ts';
import type { CreatedLicense, LicensePlan } from '../../src/services/licenses.ts';
import { createLicense } from '../../src/services/licenses.ts';
import type { TestDbSettings } from './test-db.ts';
import {
  adminSettings,
  apiSettings,
  createTestDatabase,
  dropTestDatabase,
  loadTestDbSettings,
  newTestDatabaseName,
} from './test-db.ts';

export const MIGRATIONS_DIR = join(import.meta.dirname, '..', '..', '..', 'db', 'migrations');

/** A clock that only moves when the test says so. */
export class FakeClock implements Clock {
  #now: Date;

  constructor(start: Date) {
    this.#now = truncateToSeconds(start);
  }

  now(): Date {
    return new Date(this.#now.getTime());
  }

  set(date: Date): void {
    this.#now = truncateToSeconds(date);
  }

  advanceSeconds(seconds: number): void {
    this.#now = new Date(this.#now.getTime() + seconds * 1000);
  }

  advanceDays(days: number): void {
    this.advanceSeconds(days * 86_400);
  }
}

export interface ApiResponse {
  status: number;
  // The tests assert on arbitrary fields of the JSON answer.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
  headers: Record<string, string | string[] | number | undefined>;
}

export interface HarnessOptions {
  rateLimit?: Partial<RateLimitConfig>;
  /** Run as if behind the reverse proxy (TRUST_PROXY=loopback). */
  trustProxy?: boolean;
  /** Capture the application log (JSON lines) instead of discarding it. */
  logStream?: { write(line: string): void };
  logLevel?: string;
  /** Where the fake clock starts. Default: 2026-11-10T08:00:00Z. */
  start?: Date;
}

export interface Harness {
  app: FastifyInstance;
  ctx: AppContext;
  config: Config;
  clock: FakeClock;
  settings: TestDbSettings;
  dbName: string;
  /** A connection as the test admin, for assertions and for arranging rows directly. */
  sql: Connection;
  /** The raw 32-byte public key of the in-memory signing key. */
  publicKey: Buffer;
  post(path: string, body: unknown, options?: { ip?: string; headers?: Record<string, string> }): Promise<ApiResponse>;
  get(path: string): Promise<ApiResponse>;
  /** A license created the way the CLI does it. `days` is the lifetime of a monthly license. */
  newLicense(plan?: LicensePlan, options?: { days?: number; maxDevices?: number }): Promise<CreatedLicense>;
  /** Check a token like the app would and return its payload; throws when it does not verify. */
  payloadOf(token: string): TokenPayload;
  close(): Promise<void>;
}

export const TEST_START = new Date('2026-11-10T08:00:00Z');

/** A stable fake device id (64 hex characters, like the app's SHA-256). */
export function deviceId(label: string): string {
  return createHash('sha256').update(`test-device:${label}`).digest('hex');
}

/** Listen on a free loopback port (most tests use inject() and need no socket). */
export async function listen(harness: Harness): Promise<number> {
  await harness.app.listen({ host: '127.0.0.1', port: 0 });
  const address = harness.app.server.address();
  if (address === null || typeof address === 'string') throw new Error('no TCP address');
  return address.port;
}

/** Send raw bytes to a port and return everything the server answers before it closes. */
export function rawExchange(port: number, bytes: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port });
    let answer = '';
    socket.setEncoding('utf8');
    socket.setTimeout(10_000, () => socket.destroy(new Error('no answer from the server')));
    socket.on('connect', () => socket.write(bytes));
    socket.on('data', (chunk: string) => {
      answer += chunk;
    });
    socket.on('error', reject);
    socket.on('close', () => resolve(answer));
  });
}

function toResponse(raw: { statusCode: number; body: string; headers: ApiResponse['headers'] }): ApiResponse {
  let body: unknown;
  try {
    body = JSON.parse(raw.body);
  } catch {
    body = raw.body;
  }
  return { status: raw.statusCode, body, headers: raw.headers };
}

export async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const settings = loadTestDbSettings();
  const dbName = newTestDatabaseName();
  await createTestDatabase(settings, dbName);

  const clock = new FakeClock(options.start ?? TEST_START);
  await migrate({
    connection: { ...adminSettings(settings), database: dbName },
    dir: MIGRATIONS_DIR,
    now: () => clock.now(),
  });

  const config: Config = {
    nodeEnv: 'test',
    host: '127.0.0.1',
    port: 0,
    logLevel: 'info',
    trustProxy: options.trustProxy ?? false,
    db: { ...apiSettings(settings, dbName), poolSize: 10 },
    keyEncSecret: randomBytes(32),
    signingKeyFile: '/nonexistent/in-memory-test-key',
    // High enough that only the rate-limit tests ever reach a limit.
    rateLimit: { windowSec: 60, ipMax: 100_000, keyMax: 100_000, ...options.rateLimit },
    migrationsDir: MIGRATIONS_DIR,
  };

  const signer = createSigner(generateKeyPairSync('ed25519').privateKey);
  const publicKey = Buffer.from(signer.publicKeyBase64, 'base64');
  const ctx = createAppContext(config, { clock, signer });
  const app = buildApp(ctx, {
    logging: options.logStream !== undefined,
    logStream: options.logStream,
    logLevel: options.logLevel,
  });
  await app.ready();

  const sql = await openConnection(adminSettings(settings, dbName));

  return {
    app,
    ctx,
    config,
    clock,
    settings,
    dbName,
    sql,
    publicKey,
    async post(path, body, requestOptions = {}) {
      const raw = await app.inject({
        method: 'POST',
        url: path,
        payload: JSON.stringify(body),
        headers: { 'content-type': 'application/json', ...requestOptions.headers },
        remoteAddress: requestOptions.ip ?? '198.51.100.10',
      });
      return toResponse(raw);
    },
    async get(path) {
      return toResponse(await app.inject({ method: 'GET', url: path }));
    },
    async newLicense(plan = 'lifetime', licenseOptions = {}) {
      const now = clock.now();
      return withTransaction(ctx.db, (tx) =>
        createLicense(
          tx,
          ctx.keyCipher,
          {
            email: 'buyer@example.com',
            plan,
            expiresAt: plan === 'monthly' ? addDays(now, licenseOptions.days ?? 30) : null,
            source: 'manual',
            maxDevices: licenseOptions.maxDevices,
          },
          now,
        ),
      );
    },
    payloadOf(token) {
      const check = verifyToken(token, publicKey);
      if (!check.valid) throw new Error(`token does not verify: ${check.reason}`);
      return check.payload;
    },
    async close() {
      await app.close();
      // A test may have closed the pool itself to simulate a database outage.
      await ctx.db.end().catch(() => {});
      await sql.end();
      await dropTestDatabase(settings, dbName);
    },
  };
}
