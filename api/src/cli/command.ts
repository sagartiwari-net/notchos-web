// What a CLI command looks like. To add one (for example admin:create in phase W2):
// write a Command in src/cli/commands/, and add it to the list in src/cli/index.ts.

import type { EnvValues } from '../config.ts';
import { parseConfig, readEnv } from '../config.ts';
import type { CoreContext } from '../context.ts';
import { closeContext, createCoreContext } from '../context.ts';
import { checkConnection } from '../db/pool.ts';
import type { Clock } from '../lib/time.ts';

export interface CliIo {
  /** One line to stdout. */
  out(line: string): void;
  /** One line to stderr. */
  err(line: string): void;
  /** The process environment (tests pass their own). */
  env: EnvValues;
  /** Tests pass a fixed clock; the real CLI uses the system clock. */
  clock?: Clock;
}

export interface Command {
  /** For example "license:create". */
  name: string;
  /** One line for the command list. */
  summary: string;
  /** Arguments and options, shown after the name in help and in usage errors. */
  usage: string;
  /** Runs the command with the arguments that follow its name. Returns the exit code. */
  run(args: string[], io: CliIo): Promise<number>;
}

/** Thrown by a command when its arguments are wrong: the CLI prints the usage and exits 2. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

/** Run `work` with the configured database pool, key cipher and clock; always closes the pool. */
export async function withCoreContext<T>(io: CliIo, work: (ctx: CoreContext) => Promise<T>): Promise<T> {
  const config = parseConfig(readEnv(io.env));
  await checkConnection(config.db);
  const ctx = createCoreContext(config, { clock: io.clock });
  try {
    return await work(ctx);
  } finally {
    await closeContext(ctx);
  }
}

/** Print rows as a left-aligned text table. */
export function printTable(io: CliIo, header: string[], rows: string[][]): void {
  const widths = header.map((title, column) =>
    Math.max(title.length, ...rows.map((row) => (row[column] ?? '').length)),
  );
  const line = (cells: string[]): string =>
    cells
      .map((cell, column) => cell.padEnd(widths[column] ?? 0))
      .join('  ')
      .trimEnd();
  io.out(line(header));
  io.out(line(widths.map((width) => '-'.repeat(width))));
  for (const row of rows) io.out(line(row));
}
