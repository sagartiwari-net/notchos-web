// Entry point of the API process:  node src/server.ts  (dev)  |  node dist/server.js  (built)
//
// Startup order: configuration -> signing key -> database reachable and migrated -> listen.
// Any failure stops the process with one clear line; nothing secret is printed.

import { buildApp } from './app.ts';
import { ConfigError, loadConfig } from './config.ts';
import type { AppContext } from './context.ts';
import { closeContext, createAppContext } from './context.ts';
import { MigrationError, migrationStatus } from './db/migrate.ts';
import { checkConnection, onDriverWarning } from './db/pool.ts';

class StartupError extends Error {}

function firstLine(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.split('\n', 1)[0] ?? '';
}

/** The database must answer and must have every migration of this code base applied. */
async function assertDatabaseReady(ctx: AppContext): Promise<void> {
  const { host, port, database } = ctx.config.db;
  let pending: string[];
  try {
    // One direct connection first: it fails at once and with the real reason.
    await checkConnection(ctx.config.db);
    const plan = await migrationStatus(ctx.db, ctx.config.migrationsDir);
    pending = plan.pending.map((file) => file.name);
  } catch (err) {
    if (err instanceof MigrationError) throw new StartupError(`database ${database}: ${err.message}`);
    throw new StartupError(
      `cannot use database ${database} at ${host}:${port}: ${firstLine(err)}\n` +
        '  Is MariaDB running? Local development: scripts/dev-db.sh start',
    );
  }
  if (pending.length > 0) {
    throw new StartupError(
      `database ${database} is missing ${pending.length} migration(s): ${pending.join(', ')}\n` +
        '  Apply them first: npm run db:migrate',
    );
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  const ctx = createAppContext(config);
  try {
    await assertDatabaseReady(ctx);
  } catch (err) {
    await closeContext(ctx).catch(() => {});
    throw err;
  }

  const app = buildApp(ctx);
  onDriverWarning((message) => app.log.warn({ source: 'mariadb' }, message));
  app.log.info(
    { database: config.db.database, kid: ctx.signer.kid, node_env: config.nodeEnv },
    'NotchOS API starting',
  );
  if (config.nodeEnv === 'production' && !config.trustProxy) {
    app.log.warn(
      'TRUST_PROXY is off: behind a reverse proxy every client shares one address and one rate-limit bucket',
    );
  }

  let stopping = false;
  const stop = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    app.log.info({ signal }, 'shutting down');
    app
      .close()
      .then(() => closeContext(ctx))
      .then(
        () => process.exit(0),
        (err: unknown) => {
          app.log.error({ err }, 'shutdown failed');
          process.exit(1);
        },
      );
  };
  process.once('SIGINT', () => stop('SIGINT'));
  process.once('SIGTERM', () => stop('SIGTERM'));

  await app.listen({ host: config.host, port: config.port });
}

main().catch((err: unknown) => {
  if (err instanceof ConfigError || err instanceof StartupError) {
    console.error(`Cannot start the NotchOS API: ${err.message}`);
  } else {
    console.error('Cannot start the NotchOS API:', err);
  }
  process.exit(1);
});
