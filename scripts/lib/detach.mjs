#!/usr/bin/env node
// Start a command fully detached and print its pid.
//
//   node detach.mjs <log-file> <command> [args...]
//
// The command gets its own session (setsid), no controlling terminal, stdin from
// /dev/null and stdout + stderr appended to <log-file>. It therefore survives the
// calling shell, the terminal and this helper exiting. dev-db.sh and stable-api.sh
// use it because macOS ships no setsid(1). The command inherits the environment
// and working directory of the caller.
import { spawn } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';

const [logFile, command, ...args] = process.argv.slice(2);
if (!logFile || !command) {
  console.error('usage: detach.mjs <log-file> <command> [args...]');
  process.exit(2);
}

const log = openSync(logFile, 'a', 0o600);
const child = spawn(command, args, { detached: true, stdio: ['ignore', log, log] });

child.once('error', (err) => {
  console.error(`detach: cannot start ${command}: ${err.message}`);
  process.exit(1);
});

child.once('spawn', () => {
  closeSync(log);
  process.stdout.write(`${child.pid}\n`);
  child.unref();
});
