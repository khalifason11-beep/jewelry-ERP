// Password hashing: argon2id (OWASP parameters m=19 MiB, t=2, p=1) via @node-rs/argon2, which
// runs on the libuv thread pool (never blocks the event loop). Hashes are self-describing PHC
// strings, so parameters can be raised later: `needsRehash` triggers an upgrade on next sign-in.
// Legacy scrypt hashes (format scrypt$N$r$p$salt$hash) from the prototype still verify and are
// upgraded on the next successful sign-in. Plaintext passwords are never stored, logged, or returned.

import { randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from 'node:crypto';
import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2';

/** `algorithm: 2` = Argon2id (the package's const enum cannot be imported under isolatedModules). */
export const ARGON2_PARAMS = { algorithm: 2, memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

const scrypt = (password: string, salt: Buffer, keylen: number, opts: ScryptOptions) =>
  new Promise<Buffer>((resolve, reject) =>
    scryptCb(password, salt, keylen, { ...opts, maxmem: 256 * 1024 * 1024 }, (err, key) => (err ? reject(err) : resolve(key))),
  );

export async function hashPassword(password: string): Promise<string> {
  return argonHash(password, ARGON2_PARAMS);
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  try {
    if (stored.startsWith('$argon2')) return await argonVerify(stored, password);
    if (stored.startsWith('scrypt$')) {
      const [, n, r, p, saltB64, hashB64] = stored.split('$');
      const expected = Buffer.from(hashB64, 'base64');
      const actual = await scrypt(password, Buffer.from(saltB64, 'base64'), expected.length, { N: Number(n), r: Number(r), p: Number(p) });
      return actual.length === expected.length && timingSafeEqual(actual, expected);
    }
    return false;
  } catch {
    return false;
  }
}

/** True when the stored hash is not argon2id with the current parameters. */
export function needsRehash(stored: string): boolean {
  const { memoryCost: m, timeCost: t, parallelism: p } = ARGON2_PARAMS;
  return !stored.startsWith(`$argon2id$v=19$m=${m},t=${t},p=${p}$`);
}

let dummy: Promise<string> | null = null;
/**
 * Spend the same time as a real verification when the account does not exist (or is locked),
 * so response timing does not reveal which usernames are valid (M-2).
 */
export async function burnVerification(password: string): Promise<void> {
  dummy ??= hashPassword(randomBytes(16).toString('hex'));
  await verifyPassword(password, await dummy);
}

/** Readable temporary password, e.g. "Temp-7KQ4-M9XP". Shown ONCE to the admin who reset it. */
export function generateTemporaryPassword(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const pick = (n: number) =>
    Array.from(randomBytes(n))
      .map((b) => alphabet[b % alphabet.length])
      .join('');
  // 3 groups × 4 chars from a 32-symbol alphabet = 60 bits; always contains letters and digits.
  let s: string;
  do s = `${pick(4)}-${pick(4)}-${pick(4)}`;
  while (!/[A-Z]/.test(s) || !/\d/.test(s));
  return `Temp-${s}`;
}
