// admin:create <username> <password>
//
// Admin accounts exist only because this command made them: there is no sign-up. The
// password is stored as a scrypt hash, and a fresh TOTP secret is stored encrypted. The
// secret (and the otpauth:// URL that carries it) is printed once, here, and never again.

import { hashPassword } from '../../crypto/password.ts';
import { totpSecretAad } from '../../crypto/secret-box.ts';
import { base32Encode, generateTotpSecret, otpauthUrl } from '../../crypto/totp.ts';
import { isDuplicateKeyError, write } from '../../db/pool.ts';
import type { CliIo, Command } from '../command.ts';
import { UsageError, withCoreContext } from '../command.ts';

export const ADMIN_USERNAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,63}$/;
export const ADMIN_PASSWORD_MIN_LENGTH = 12;
const ADMIN_PASSWORD_MAX_LENGTH = 200;
const TOTP_ISSUER = 'NotchOS Admin';

const create: Command = {
  name: 'admin:create',
  summary: 'Create an admin account and print its authenticator setup once',
  usage: '<username> <password>',
  async run(args: string[], io: CliIo): Promise<number> {
    // A "--" is dropped, so a password can start with a dash: admin:create alice -- '-my password-'
    const separator = args.indexOf('--');
    const rest = separator === -1 ? args : [...args.slice(0, separator), ...args.slice(separator + 1)];
    const [username, password, ...extra] = rest;
    if (username === undefined || password === undefined || extra.length > 0) {
      throw new UsageError('expected a username and a password');
    }
    if (!ADMIN_USERNAME_PATTERN.test(username)) {
      throw new UsageError('username: 1-64 characters from A-Z a-z 0-9 . _ @ - (starting with a letter or digit)');
    }
    if (password.length < ADMIN_PASSWORD_MIN_LENGTH || password.length > ADMIN_PASSWORD_MAX_LENGTH) {
      throw new UsageError(`password: ${ADMIN_PASSWORD_MIN_LENGTH} to ${ADMIN_PASSWORD_MAX_LENGTH} characters`);
    }

    const passwordHash = await hashPassword(password);
    const secret = generateTotpSecret();

    return withCoreContext(io, async (ctx) => {
      try {
        await write(
          ctx.db,
          'INSERT INTO admin_users (username, password_hash, totp_secret_enc, last_login_at) VALUES (?, ?, ?, NULL)',
          [username, passwordHash, ctx.secretBox.encrypt(secret, totpSecretAad(username))],
        );
      } catch (err) {
        if (isDuplicateKeyError(err)) {
          io.err(`admin:create: an admin named "${username}" already exists`);
          return 1;
        }
        throw err;
      }
      io.out(`Admin "${username}" created.`);
      io.out('');
      io.out('Add it to an authenticator app now. This is the only time the secret is shown.');
      io.out(`  otpauth URL   ${otpauthUrl({ issuer: TOTP_ISSUER, account: username, secret })}`);
      io.out(`  base32 secret ${base32Encode(secret)}`);
      return 0;
    });
  },
};

export const adminCommands: Command[] = [create];
