// The one command-line entry point of the API package.
//
//   node src/cli/index.ts <command> [arguments]      (npm run cli -- <command> ...)
//   node dist/cli/index.js <command> [arguments]     (built; used by the stable copy)
//
// Commands live in src/cli/commands/. To add one, export a Command there and add it to
// COMMANDS below. Configuration comes from the same env file as the API (see config.ts).

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ConfigError } from '../config.ts';
import { MigrationError } from '../db/migrate.ts';
import type { CliIo, Command } from './command.ts';
import { UsageError } from './command.ts';
import { adminCommands } from './commands/admin.ts';
import { dbCommands } from './commands/db.ts';
import { emailCommands } from './commands/email.ts';
import { licenseCommands } from './commands/license.ts';

export const COMMANDS: Command[] = [...licenseCommands, ...adminCommands, ...dbCommands, ...emailCommands];

function printHelp(io: CliIo): void {
  io.out('NotchOS API command line');
  io.out('');
  io.out('Usage: npm run cli -- <command> [arguments]');
  io.out('');
  const width = Math.max(...COMMANDS.map((command) => command.name.length));
  for (const command of COMMANDS) {
    io.out(`  ${command.name.padEnd(width)}  ${command.summary}`);
    if (command.usage !== '') io.out(`  ${' '.repeat(width)}    ${command.name} ${command.usage}`);
  }
}

function firstLine(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.split('\n', 1)[0] ?? '';
}

/** Run one command. Returns the process exit code: 0 ok, 1 failed, 2 wrong usage. */
export async function runCli(argv: string[], io: CliIo): Promise<number> {
  const [name, ...args] = argv;
  if (name === undefined || name === 'help' || name === '--help' || name === '-h') {
    printHelp(io);
    return name === undefined ? 2 : 0;
  }
  const command = COMMANDS.find((candidate) => candidate.name === name);
  if (command === undefined) {
    io.err(`Unknown command: ${name}`);
    io.err('Run with --help to see the commands.');
    return 2;
  }

  try {
    return await command.run(args, io);
  } catch (err) {
    if (err instanceof UsageError) {
      io.err(`${command.name}: ${err.message}`);
      io.err(`Usage: ${command.name} ${command.usage}`.trimEnd());
      return 2;
    }
    if (err instanceof ConfigError || err instanceof MigrationError) {
      io.err(`${command.name}: ${err.message}`);
      return 1;
    }
    // Database and other unexpected errors: one line, unless DEBUG is set.
    io.err(`${command.name} failed: ${firstLine(err)}`);
    if (io.env.DEBUG !== undefined && err instanceof Error && err.stack !== undefined) io.err(err.stack);
    return 1;
  }
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) {
  const io: CliIo = {
    out: (line) => console.log(line),
    err: (line) => console.error(line),
    env: process.env,
  };
  runCli(process.argv.slice(2), io).then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      console.error(err);
      process.exitCode = 1;
    },
  );
}
