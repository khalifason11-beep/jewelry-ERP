// Password policy (docs/decisions.md D-1a-12). Applies to self-chosen passwords and to temporary
// passwords typed by an administrator. Returns the first violated rule as a translatable error.

import { badRequest } from '../core/errors';

/** Tiny deny-list of the most common passwords/patterns seen in credential-stuffing lists. */
const COMMON = new Set([
  'password', 'password1', 'password123', 'passw0rd', '123456789', '1234567890', 'qwerty123', 'qwertyuiop',
  'iloveyou1', 'admin1234', 'administrator', 'welcome123', 'letmein123', 'abc1234567', 'changeme123',
  'sudan12345', 'khartoum123', 'gold123456', 'jewelry123',
]);

export function assertPasswordPolicy(password: string, opts: { minLength: number; username?: string }): void {
  if (password.length < opts.minLength) throw badRequest('Password must be at least {n} characters', { n: opts.minLength });
  if (password.length > 128) throw badRequest('Password must be at most {n} characters', { n: 128 });
  if (!/[A-Za-z؀-ۿ]/.test(password) || !/\d/.test(password)) throw badRequest('Use letters and digits');
  const lower = password.toLowerCase();
  if (opts.username && opts.username.length >= 3 && lower.includes(opts.username.toLowerCase())) {
    throw badRequest('The password must not contain the username');
  }
  if (COMMON.has(lower)) throw badRequest('This password is too common');
}
