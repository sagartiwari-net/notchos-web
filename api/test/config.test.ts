import { randomBytes } from 'node:crypto';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { EnvValues } from '../src/config.ts';
import {
  assertPrivateFile,
  ConfigError,
  migrationsDir,
  parseConfig,
  parseMigrateCredentials,
  readEnv,
  readMigrateEnv,
} from '../src/config.ts';

const scratch = mkdtempSync(join(tmpdir(), 'notchos-config-test-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const SECRET = randomBytes(32).toString('base64');
const PASSWORD = 'db-password-that-must-never-be-printed';

function valid(overrides: Record<string, string | undefined> = {}): EnvValues {
  return {
    DB_NAME: 'notchos_dev',
    DB_USER: 'notchos_dev_api',
    DB_PASSWORD: PASSWORD,
    KEY_ENC_SECRET: SECRET,
    SIGNING_KEY_FILE: '/tmp/key.pem',
    ...overrides,
  };
}

function errorOf(action: () => unknown): Error {
  try {
    action();
  } catch (err) {
    return err as Error;
  }
  throw new Error('expected an error');
}

describe('parseConfig', () => {
  it('applies the local defaults', () => {
    const config = parseConfig(valid());
    expect(config).toMatchObject({
      nodeEnv: 'development',
      host: '127.0.0.1',
      port: 4310,
      logLevel: 'info',
      trustProxy: false,
      db: { host: '127.0.0.1', port: 3307, database: 'notchos_dev', user: 'notchos_dev_api', poolSize: 10 },
      signingKeyFile: '/tmp/key.pem',
      rateLimit: { windowSec: 60, ipMax: 30, keyMax: 10 },
    });
    expect(config.keyEncSecret).toHaveLength(32);
    expect(config.migrationsDir).toMatch(/db[/\\]migrations$/);
  });

  it('reads every setting from the values it is given', () => {
    const config = parseConfig(
      valid({
        NODE_ENV: 'production',
        HOST: '::1',
        PORT: '4320',
        LOG_LEVEL: 'warn',
        TRUST_PROXY: 'loopback',
        DB_HOST: 'localhost',
        DB_PORT: '3306',
        DB_POOL_SIZE: '4',
        RATE_LIMIT_WINDOW_SEC: '10',
        RATE_LIMIT_IP_MAX: '3',
        RATE_LIMIT_KEY_MAX: '2',
        MIGRATIONS_DIR: '/srv/notchos/db/migrations',
      }),
    );
    expect(config).toMatchObject({
      nodeEnv: 'production',
      host: '::1',
      port: 4320,
      logLevel: 'warn',
      trustProxy: true,
      db: { host: 'localhost', port: 3306, poolSize: 4 },
      rateLimit: { windowSec: 10, ipMax: 3, keyMax: 2 },
      migrationsDir: '/srv/notchos/db/migrations',
    });
  });

  it('names the variable that is missing', () => {
    for (const name of ['DB_NAME', 'DB_USER', 'DB_PASSWORD', 'KEY_ENC_SECRET', 'SIGNING_KEY_FILE']) {
      const error = errorOf(() => parseConfig(valid({ [name]: undefined })));
      expect(error).toBeInstanceOf(ConfigError);
      expect(error.message).toBe(`${name} is not set`);
    }
  });

  it('only listens on loopback', () => {
    for (const host of ['0.0.0.0', '::', '192.168.1.20', 'example.com']) {
      expect(() => parseConfig(valid({ HOST: host })), host).toThrow(/HOST must be 127\.0\.0\.1 or ::1/);
    }
  });

  it('rejects values of the wrong shape', () => {
    expect(() => parseConfig(valid({ PORT: 'abc' }))).toThrow(/PORT must be a whole number/);
    expect(() => parseConfig(valid({ PORT: '70000' }))).toThrow(/PORT must be between/);
    expect(() => parseConfig(valid({ NODE_ENV: 'staging' }))).toThrow(/NODE_ENV must be one of/);
    expect(() => parseConfig(valid({ LOG_LEVEL: 'loud' }))).toThrow(/LOG_LEVEL must be one of/);
    expect(() => parseConfig(valid({ TRUST_PROXY: 'true' }))).toThrow(/TRUST_PROXY must be one of: false, loopback/);
    expect(() => parseConfig(valid({ RATE_LIMIT_IP_MAX: '0' }))).toThrow(/RATE_LIMIT_IP_MAX must be between/);
    expect(() => parseConfig(valid({ DB_NAME: 'notchos`; DROP' }))).toThrow(/DB_NAME may only contain/);
  });

  it('needs exactly 32 bytes of base64 for the key encryption secret', () => {
    for (const bad of [randomBytes(16).toString('base64'), randomBytes(33).toString('base64'), 'not base64 !!', 'x'.repeat(44)]) {
      expect(() => parseConfig(valid({ KEY_ENC_SECRET: bad }))).toThrow(/KEY_ENC_SECRET must be 32 random bytes/);
    }
    expect(parseConfig(valid({ KEY_ENC_SECRET: SECRET.replace(/=+$/, '') })).keyEncSecret).toHaveLength(32);
  });

  it('never puts a secret value into an error message', () => {
    const tries: Array<() => unknown> = [
      () => parseConfig(valid({ KEY_ENC_SECRET: `${SECRET}broken` })),
      () => parseConfig(valid({ PORT: PASSWORD })),
      () => parseConfig(valid({ DB_NAME: undefined })),
      () => parseMigrateCredentials({ DB_MIGRATE_USER: 'u' }),
    ];
    for (const attempt of tries) {
      const message = errorOf(attempt).message;
      expect(message).not.toContain(SECRET);
      expect(message).not.toContain(PASSWORD);
    }
  });
});

describe('env files', () => {
  function envFile(name: string, content: string, mode = 0o600): string {
    const path = join(scratch, name);
    writeFileSync(path, content, { mode });
    chmodSync(path, mode);
    return path;
  }

  it('reads the file named by NOTCHOS_ENV_FILE; real environment variables win', () => {
    const path = envFile('api.env', `# comment\nDB_NAME=from_file\nDB_USER=file_user\nPORT=4999\n`);
    const values = readEnv({ NOTCHOS_ENV_FILE: path, DB_USER: 'env_user' });
    expect(values.DB_NAME).toBe('from_file');
    expect(values.PORT).toBe('4999');
    expect(values.DB_USER).toBe('env_user');
  });

  it('reads no file at all when NOTCHOS_ENV_FILE is empty', () => {
    const env = { NOTCHOS_ENV_FILE: '', DB_NAME: 'only_env' };
    expect(readEnv(env)).toBe(env);
  });

  it('never picks up the dev files of ~/.notchos-dev in tests or in production', () => {
    for (const NODE_ENV of ['test', 'production']) {
      const env = { NODE_ENV, DB_NAME: 'only_env' };
      expect(readEnv(env)).toBe(env);
      expect(readMigrateEnv(env)).toBe(env);
    }
  });

  it('fails when the named file does not exist', () => {
    expect(() => readEnv({ NOTCHOS_ENV_FILE: join(scratch, 'missing.env') })).toThrow(/not found/);
  });

  it('refuses an env file that other users can read', () => {
    const path = envFile('open.env', 'DB_PASSWORD=x\n', 0o644);
    expect(() => readEnv({ NOTCHOS_ENV_FILE: path })).toThrow(/can be read by other users \(mode 644\)/);
    expect(() => assertPrivateFile(path, 'File')).toThrow(ConfigError);
    chmodSync(path, 0o600);
    expect(() => assertPrivateFile(path, 'File')).not.toThrow();
  });

  it('keeps the migration credentials in their own file', () => {
    const api = envFile('api2.env', 'DB_NAME=notchos_dev\nDB_USER=api_user\nDB_PASSWORD=api_pw\n');
    const migrate = envFile('migrate.env', 'DB_MIGRATE_USER=migrate_user\nDB_MIGRATE_PASSWORD=migrate_pw\n');

    // The API's view has no migration credentials ...
    const apiValues = readEnv({ NOTCHOS_ENV_FILE: api, NOTCHOS_MIGRATE_ENV_FILE: migrate });
    expect(apiValues.DB_MIGRATE_USER).toBeUndefined();
    expect(apiValues.DB_MIGRATE_PASSWORD).toBeUndefined();

    // ... the migration commands see both files.
    const migrateValues = readMigrateEnv({ NOTCHOS_ENV_FILE: api, NOTCHOS_MIGRATE_ENV_FILE: migrate });
    expect(parseMigrateCredentials(migrateValues)).toEqual({ user: 'migrate_user', password: 'migrate_pw' });
    expect(migrateValues.DB_NAME).toBe('notchos_dev');
  });
});

describe('migrationsDir', () => {
  it('defaults to db/migrations next to the api package and can be overridden', () => {
    expect(migrationsDir({})).toBe(join(import.meta.dirname, '..', '..', 'db', 'migrations'));
    expect(migrationsDir({ MIGRATIONS_DIR: '/somewhere/else' })).toBe('/somewhere/else');
  });
});
