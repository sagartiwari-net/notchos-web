// Configuration: read once at startup, validated, then passed around as a plain object.
//
// Where values come from, lowest to highest priority:
//   1. an env file: the path in NOTCHOS_ENV_FILE, or, in development (NODE_ENV unset or
//      "development"), the dev file ~/.notchos-dev/env/dev.env when it exists;
//   2. real environment variables.
// Secrets therefore never live in the repository. api/.env.example documents every name.
//
// Error messages name the variable that is wrong, never its value.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseEnv } from 'node:util';

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export type NodeEnv = 'development' | 'test' | 'production';
export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';
export type EnvValues = Readonly<Record<string, string | undefined>>;

/** Which database, without credentials. */
export interface DbTarget {
  host: string;
  port: number;
  database: string;
}

export interface DbCredentials {
  user: string;
  password: string;
}

export interface RateLimitConfig {
  /** Length of one counting window in seconds. */
  windowSec: number;
  /** Requests per window from one IP address across the license routes. */
  ipMax: number;
  /** Requests per window for one license key (or one device id on /v1/trial). */
  keyMax: number;
}

export interface Config {
  nodeEnv: NodeEnv;
  /** Listen address. Loopback only: the API always sits behind a reverse proxy. */
  host: string;
  port: number;
  logLevel: LogLevel;
  /** True when a reverse proxy on this machine sets X-Forwarded-For. */
  trustProxy: boolean;
  db: DbTarget & DbCredentials & { poolSize: number };
  /** AES-256-GCM key (32 bytes) that encrypts licenses.key_enc. */
  keyEncSecret: Buffer;
  /** Path of the Ed25519 private key (PKCS#8 PEM) that signs tokens. */
  signingKeyFile: string;
  rateLimit: RateLimitConfig;
  /** Folder with the SQL migrations; the API refuses to start when the database is behind it. */
  migrationsDir: string;
}

const DEV_HOME = join(homedir(), '.notchos-dev');
export const DEFAULT_DEV_ENV_FILE = join(DEV_HOME, 'env', 'dev.env');
export const DEFAULT_DEV_MIGRATE_ENV_FILE = join(DEV_HOME, 'env', 'dev-migrate.env');

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1']);
const LOG_LEVELS: readonly LogLevel[] = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'];
const NODE_ENVS: readonly NodeEnv[] = ['development', 'test', 'production'];

/**
 * A file that holds secrets must not be accessible to other users (like ssh does for keys).
 */
export function assertPrivateFile(path: string, what: string): void {
  let mode: number;
  try {
    mode = statSync(path).mode;
  } catch {
    throw new ConfigError(`${what} not found: ${path}`);
  }
  if (process.platform !== 'win32' && (mode & 0o077) !== 0) {
    const shown = (mode & 0o777).toString(8).padStart(3, '0');
    throw new ConfigError(
      `${what} ${path} can be read by other users (mode ${shown}). Run: chmod 600 "${path}"`,
    );
  }
}

function readEnvFile(path: string, what: string): Record<string, string> {
  assertPrivateFile(path, what);
  const parsed = parseEnv(readFileSync(path, 'utf8'));
  const values: Record<string, string> = {};
  for (const [name, value] of Object.entries(parsed)) {
    if (value !== undefined) values[name] = value;
  }
  return values;
}

function merge(fileValues: Record<string, string>, env: EnvValues): EnvValues {
  const merged: Record<string, string | undefined> = { ...fileValues };
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined) merged[name] = value;
  }
  return merged;
}

/**
 * The values the API and the CLI are configured from: the env file (if any) with real
 * environment variables on top.
 */
export function readEnv(env: EnvValues = process.env): EnvValues {
  const explicit = env.NOTCHOS_ENV_FILE;
  if (explicit !== undefined) {
    // An empty value means: read no file at all, use the environment only.
    if (explicit === '') return env;
    return merge(readEnvFile(resolve(explicit), 'Env file (NOTCHOS_ENV_FILE)'), env);
  }
  if (isDevelopment(env) && existsSync(DEFAULT_DEV_ENV_FILE)) {
    return merge(readEnvFile(DEFAULT_DEV_ENV_FILE, 'Dev env file'), env);
  }
  return env;
}

/** The dev files in ~/.notchos-dev are picked up by themselves in development only. */
function isDevelopment(env: EnvValues): boolean {
  return env.NODE_ENV === undefined || env.NODE_ENV === '' || env.NODE_ENV === 'development';
}

/**
 * The values migrations are configured from. The migration user's credentials are kept in
 * their own file so that the running API never holds them: NOTCHOS_MIGRATE_ENV_FILE, or,
 * in development, ~/.notchos-dev/env/dev-migrate.env when it exists.
 */
export function readMigrateEnv(env: EnvValues = process.env): EnvValues {
  const base = readEnv(env);
  const explicit = env.NOTCHOS_MIGRATE_ENV_FILE;
  if (explicit !== undefined) {
    if (explicit === '') return base;
    return merge(readEnvFile(resolve(explicit), 'Migration env file (NOTCHOS_MIGRATE_ENV_FILE)'), base);
  }
  if (isDevelopment(base) && existsSync(DEFAULT_DEV_MIGRATE_ENV_FILE)) {
    return merge(readEnvFile(DEFAULT_DEV_MIGRATE_ENV_FILE, 'Dev migration env file'), base);
  }
  return base;
}

// ---- field readers -------------------------------------------------------------------

function optional(values: EnvValues, name: string): string | undefined {
  const value = values[name];
  return value === undefined || value.trim() === '' ? undefined : value.trim();
}

function required(values: EnvValues, name: string): string {
  const value = optional(values, name);
  if (value === undefined) throw new ConfigError(`${name} is not set`);
  return value;
}

function integer(values: EnvValues, name: string, fallback: number, min: number, max: number): number {
  const raw = optional(values, name);
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw)) throw new ConfigError(`${name} must be a whole number`);
  const value = Number(raw);
  if (value < min || value > max) throw new ConfigError(`${name} must be between ${min} and ${max}`);
  return value;
}

function oneOf<T extends string>(values: EnvValues, name: string, allowed: readonly T[], fallback: T): T {
  const raw = optional(values, name);
  if (raw === undefined) return fallback;
  if (!(allowed as readonly string[]).includes(raw)) {
    throw new ConfigError(`${name} must be one of: ${allowed.join(', ')}`);
  }
  return raw as T;
}

// ---- parsers -------------------------------------------------------------------------

export function parseDbTarget(values: EnvValues): DbTarget {
  const database = required(values, 'DB_NAME');
  if (!/^[A-Za-z0-9_]{1,64}$/.test(database)) {
    throw new ConfigError('DB_NAME may only contain letters, digits and underscores');
  }
  return {
    host: optional(values, 'DB_HOST') ?? '127.0.0.1',
    port: integer(values, 'DB_PORT', 3307, 1, 65535),
    database,
  };
}

export function parseMigrateCredentials(values: EnvValues): DbCredentials {
  return {
    user: required(values, 'DB_MIGRATE_USER'),
    password: required(values, 'DB_MIGRATE_PASSWORD'),
  };
}

export function parseKeyEncSecret(values: EnvValues): Buffer {
  const raw = required(values, 'KEY_ENC_SECRET');
  const secret = Buffer.from(raw, 'base64');
  // Re-encoding catches characters that are not base64 at all (Buffer.from skips them).
  if (secret.length !== 32 || secret.toString('base64').replace(/=+$/, '') !== raw.replace(/=+$/, '')) {
    throw new ConfigError('KEY_ENC_SECRET must be 32 random bytes in base64 (openssl rand -base64 32)');
  }
  return secret;
}

export function parseConfig(values: EnvValues): Config {
  const host = optional(values, 'HOST') ?? '127.0.0.1';
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new ConfigError('HOST must be 127.0.0.1 or ::1 (the API is only reachable through the reverse proxy)');
  }

  const config: Config = {
    nodeEnv: oneOf(values, 'NODE_ENV', NODE_ENVS, 'development'),
    host,
    port: integer(values, 'PORT', 4310, 1, 65535),
    logLevel: oneOf(values, 'LOG_LEVEL', LOG_LEVELS, 'info'),
    trustProxy: oneOf(values, 'TRUST_PROXY', ['false', 'loopback'] as const, 'false') === 'loopback',
    db: {
      ...parseDbTarget(values),
      user: required(values, 'DB_USER'),
      password: required(values, 'DB_PASSWORD'),
      poolSize: integer(values, 'DB_POOL_SIZE', 10, 1, 100),
    },
    keyEncSecret: parseKeyEncSecret(values),
    signingKeyFile: resolve(required(values, 'SIGNING_KEY_FILE')),
    rateLimit: {
      windowSec: integer(values, 'RATE_LIMIT_WINDOW_SEC', 60, 1, 86_400),
      ipMax: integer(values, 'RATE_LIMIT_IP_MAX', 30, 1, 1_000_000),
      keyMax: integer(values, 'RATE_LIMIT_KEY_MAX', 10, 1, 1_000_000),
    },
    migrationsDir: migrationsDir(values),
  };
  return config;
}

/** Full API configuration from the env file and the environment. */
export function loadConfig(env: EnvValues = process.env): Config {
  return parseConfig(readEnv(env));
}

/** Where the SQL migrations live: MIGRATIONS_DIR, or <repo>/db/migrations next to this package. */
export function migrationsDir(values: EnvValues = process.env): string {
  const explicit = optional(values, 'MIGRATIONS_DIR');
  if (explicit !== undefined) return resolve(explicit);
  // This file is api/src/config.ts or api/dist/config.js: two levels up is the folder
  // that holds both api/ and db/ (the repository, or a stable-copy snapshot).
  return join(import.meta.dirname, '..', '..', 'db', 'migrations');
}
