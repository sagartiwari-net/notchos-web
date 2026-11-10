// license:create, license:revoke, license:reset-seat, license:list

import { parseArgs } from 'node:util';
import { withTransaction } from '../../db/pool.ts';
import { addSeconds, toIso } from '../../lib/time.ts';
import type { LicensePlan, LicenseStatus } from '../../services/licenses.ts';
import {
  createLicense,
  expireLicense,
  LICENSE_PLANS,
  LICENSE_STATUSES,
  listLicenses,
  resetSeats,
  resolveLicenseRef,
  revokeLicense,
} from '../../services/licenses.ts';
import type { CliIo, Command } from '../command.ts';
import { printTable, UsageError, withCoreContext } from '../command.ts';

const DEFAULT_MONTHLY_DAYS = 30;

function parse<T extends NonNullable<Parameters<typeof parseArgs>[0]>['options']>(args: string[], options: T) {
  try {
    return parseArgs({ args, options, allowPositionals: true, strict: true });
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message : String(err));
  }
}

function wholeNumber(text: string, name: string, min: number, max: number): number {
  if (!/^\d+$/.test(text)) throw new UsageError(`${name} must be a whole number`);
  const value = Number(text);
  if (value < min || value > max) throw new UsageError(`${name} must be between ${min} and ${max}`);
  return value;
}

function oneOf<T extends string>(text: string, name: string, allowed: readonly T[]): T {
  if (!(allowed as readonly string[]).includes(text)) {
    throw new UsageError(`${name} must be one of: ${allowed.join(', ')}`);
  }
  return text as T;
}

const create: Command = {
  name: 'license:create',
  summary: 'Create a manual license and print its key once',
  usage: '<email> <monthly|lifetime> [--days N | --minutes N] [--note TEXT]',
  async run(args: string[], io: CliIo): Promise<number> {
    const { values, positionals } = parse(args, {
      days: { type: 'string' },
      minutes: { type: 'string' },
      note: { type: 'string' },
    });
    const [email, planText, ...extra] = positionals;
    if (email === undefined || planText === undefined || extra.length > 0) {
      throw new UsageError('expected an email address and a plan');
    }
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new UsageError('that does not look like an email address');
    }
    const plan = oneOf<LicensePlan>(planText, 'plan', LICENSE_PLANS);
    if (plan === 'lifetime' && (values.days !== undefined || values.minutes !== undefined)) {
      throw new UsageError('a lifetime license has no expiry: --days and --minutes are for monthly');
    }
    if (values.days !== undefined && values.minutes !== undefined) {
      throw new UsageError('use either --days or --minutes');
    }
    if (values.note !== undefined && values.note.length > 2000) {
      throw new UsageError('--note is limited to 2000 characters');
    }
    // How long a monthly license runs, in seconds. Checked before anything is opened.
    let lifetimeSeconds: number | null = null;
    if (plan === 'monthly') {
      lifetimeSeconds =
        values.minutes !== undefined
          ? wholeNumber(values.minutes, '--minutes', 1, 527_040) * 60
          : (values.days === undefined ? DEFAULT_MONTHLY_DAYS : wholeNumber(values.days, '--days', 1, 3660)) * 86_400;
    }

    return withCoreContext(io, async (ctx) => {
      const now = ctx.clock.now();
      const expiresAt = lifetimeSeconds === null ? null : addSeconds(now, lifetimeSeconds);
      const license = await withTransaction(ctx.db, (tx) =>
        createLicense(tx, ctx.keyCipher, { email, plan, expiresAt, source: 'manual', note: values.note ?? null }, now),
      );
      io.out('License created.');
      io.out(`  id       ${license.id}`);
      io.out(`  email    ${license.email}`);
      io.out(`  plan     ${license.plan}`);
      io.out(`  expires  ${license.expiresAt === null ? 'never (lifetime)' : toIso(license.expiresAt)}`);
      io.out(`  key      ${license.key}`);
      io.out('');
      io.out('The key is shown this one time. The database holds only its hash and an encrypted copy.');
      return 0;
    });
  },
};

const revoke: Command = {
  name: 'license:revoke',
  summary: 'Revoke a license: the Mac loses Pro on its next refresh',
  usage: '<license id | key>',
  async run(args: string[], io: CliIo): Promise<number> {
    const { positionals } = parse(args, {});
    const [ref, ...extra] = positionals;
    if (ref === undefined || extra.length > 0) throw new UsageError('expected one license id or key');

    return withCoreContext(io, async (ctx) => {
      const id = await resolveLicenseRef(ctx.db, ref);
      const result = id === null ? null : await revokeLicense(ctx.db, id, 'cli', ctx.clock.now());
      if (id === null || result === null) {
        io.err('No such license.');
        return 1;
      }
      io.out(result.changed ? `License ${id} revoked.` : `License ${id} was already revoked.`);
      return 0;
    });
  },
};

const resetSeat: Command = {
  name: 'license:reset-seat',
  summary: 'Free the seat(s) of a license so it can be activated on another Mac',
  usage: '<license id | key> [--reset-transfers]',
  async run(args: string[], io: CliIo): Promise<number> {
    const { values, positionals } = parse(args, { 'reset-transfers': { type: 'boolean' } });
    const [ref, ...extra] = positionals;
    if (ref === undefined || extra.length > 0) throw new UsageError('expected one license id or key');

    return withCoreContext(io, async (ctx) => {
      const id = await resolveLicenseRef(ctx.db, ref);
      const result =
        id === null
          ? null
          : await resetSeats(
              ctx.db,
              id,
              { resetTransfers: values['reset-transfers'] === true, by: 'cli' },
              ctx.clock.now(),
            );
      if (id === null || result === null) {
        io.err('No such license.');
        return 1;
      }
      io.out(`License ${id}: freed ${result.seatsFreed} seat(s).`);
      if (result.transfersReset) io.out(`License ${id}: transfer counter reset to 0.`);
      return 0;
    });
  },
};

const list: Command = {
  name: 'license:list',
  summary: 'List licenses, newest first (keys are never shown, only their last 4 characters)',
  usage: '[--email PART] [--status active|revoked] [--plan monthly|lifetime] [--limit N] [--json]',
  async run(args: string[], io: CliIo): Promise<number> {
    const { values, positionals } = parse(args, {
      email: { type: 'string' },
      status: { type: 'string' },
      plan: { type: 'string' },
      limit: { type: 'string' },
      json: { type: 'boolean' },
    });
    if (positionals.length > 0) throw new UsageError('license:list takes options only');
    const filter = {
      email: values.email,
      status: values.status === undefined ? undefined : oneOf<LicenseStatus>(values.status, '--status', LICENSE_STATUSES),
      plan: values.plan === undefined ? undefined : oneOf<LicensePlan>(values.plan, '--plan', LICENSE_PLANS),
      limit: values.limit === undefined ? 50 : wholeNumber(values.limit, '--limit', 1, 1000),
    };

    return withCoreContext(io, async (ctx) => {
      const licenses = await listLicenses(ctx.db, filter);
      if (values.json === true) {
        io.out(
          JSON.stringify(
            licenses.map((license) => ({
              ...license,
              expires_at: license.expires_at === null ? null : toIso(license.expires_at),
              created_at: toIso(license.created_at),
            })),
            null,
            2,
          ),
        );
        return 0;
      }
      if (licenses.length === 0) {
        io.out('No licenses.');
        return 0;
      }
      printTable(
        io,
        ['ID', 'PLAN', 'STATUS', 'EMAIL', 'KEY', 'EXPIRES', 'SEATS', 'MAC', 'TRANSFERS', 'CREATED'],
        licenses.map((license) => [
          String(license.id),
          license.plan,
          license.status,
          license.email,
          `...${license.key_hint}`,
          license.expires_at === null ? 'never' : toIso(license.expires_at),
          `${license.seats_used}/${license.max_devices}`,
          license.device_name ?? '-',
          String(license.transfers_used),
          toIso(license.created_at),
        ]),
      );
      return 0;
    });
  },
};

const expire: Command = {
  name: 'license:expire',
  summary: 'Force a monthly license to expire now (for testing the Mac app)',
  usage: '<license id | key>',
  async run(args: string[], io: CliIo): Promise<number> {
    const { positionals } = parse(args, {});
    const [ref, ...extra] = positionals;
    if (ref === undefined || extra.length > 0) throw new UsageError('expected one license id or key');

    return withCoreContext(io, async (ctx) => {
      const id = await resolveLicenseRef(ctx.db, ref);
      if (id === null) {
        io.err('No such license.');
        return 1;
      }
      try {
        const now = ctx.clock.now();
        const license = await expireLicense(ctx.db, id, now, 'cli', now);
        if (license === null) {
          io.err('No such license.');
          return 1;
        }
        io.out(`License ${id} expired at ${toIso(now)}.`);
        return 0;
      } catch (err) {
        io.err(err instanceof Error ? err.message : String(err));
        return 1;
      }
    });
  },
};

export const licenseCommands: Command[] = [create, revoke, expire, resetSeat, list];
