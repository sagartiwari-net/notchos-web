// Runs once before all test files: make sure the private MariaDB answers, and clear out
// test databases that a crashed run left behind.

import { openConnection } from '../src/db/pool.ts';
import { adminSettings, dropStaleTestDatabases, loadTestDbSettings } from './helpers/test-db.ts';

export default async function setup(): Promise<void> {
  const settings = loadTestDbSettings();
  try {
    const conn = await openConnection(adminSettings(settings));
    await conn.end();
  } catch (err) {
    const reason = err instanceof Error ? (err.message.split('\n', 1)[0] ?? '') : String(err);
    throw new Error(
      `The tests need the private MariaDB on ${settings.host}:${settings.port} (${reason}).\n` +
        'Start it with: scripts/dev-db.sh start',
    );
  }
  await dropStaleTestDatabases(settings);
}
