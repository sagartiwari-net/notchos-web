// The objects the rest of the code works with, built once from the configuration and
// passed in explicitly (no globals). Route groups, services and CLI commands receive the
// context they need; tests build one with a fake clock and a throwaway database.

import type { Config } from './config.ts';
import { LicenseKeyCipher } from './crypto/license-key.ts';
import type { TokenSigner } from './crypto/signing.ts';
import { loadSigner } from './crypto/signing.ts';
import type { Db } from './db/pool.ts';
import { openPool } from './db/pool.ts';
import { RateLimiter } from './lib/rate-limit.ts';
import type { Clock } from './lib/time.ts';
import { systemClock } from './lib/time.ts';

/** What the CLI and background work need: no HTTP, no signing key. */
export interface CoreContext {
  config: Config;
  db: Db;
  keyCipher: LicenseKeyCipher;
  clock: Clock;
}

/** What the HTTP server needs on top of that. */
export interface AppContext extends CoreContext {
  signer: TokenSigner;
  rateLimiter: RateLimiter;
}

export interface ContextOverrides {
  db?: Db;
  clock?: Clock;
  signer?: TokenSigner;
}

export function createCoreContext(config: Config, overrides: ContextOverrides = {}): CoreContext {
  return {
    config,
    db: overrides.db ?? openPool(config.db),
    keyCipher: new LicenseKeyCipher(config.keyEncSecret),
    clock: overrides.clock ?? systemClock,
  };
}

export function createAppContext(config: Config, overrides: ContextOverrides = {}): AppContext {
  // Load the signing key first: if it is missing there is no point in opening a pool.
  const signer = overrides.signer ?? loadSigner(config.signingKeyFile);
  return {
    ...createCoreContext(config, overrides),
    signer,
    rateLimiter: new RateLimiter(config.rateLimit.windowSec),
  };
}

export async function closeContext(ctx: CoreContext): Promise<void> {
  await ctx.db.end();
}
