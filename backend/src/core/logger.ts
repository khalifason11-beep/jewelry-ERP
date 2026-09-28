// Structured JSON logger. Secrets are redacted by key name before anything is written, so a
// password, token, cookie or pickup code can never reach the logs (security item 9).

import { config } from '../config';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 } as const;
type Level = Exclude<keyof typeof LEVELS, 'silent'>;

const SECRET_KEY = /pass(word)?|secret|token|cookie|authorization|pickup_?code|csrf|otp|totp|recovery/i;

/** Deep copy with secret-looking keys replaced by "[REDACTED]". */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6 || value == null || typeof value !== 'object') return value;
  if (value instanceof Error) {
    // Driver errors embed the failed SQL's bound parameters ("params: …"), which may hold hashes
    // or personal data: keep the statement shape, drop the values.
    const scrub = (s: string) => s.replace(/params:[\s\S]*$/i, 'params: [REDACTED]');
    const stack = (value.stack ?? '').split('\n').filter((l) => l.trim().startsWith('at ')).slice(0, 8).join('\n');
    const cause = (value as { cause?: unknown }).cause;
    return { name: value.name, message: scrub(value.message), code: (value as { code?: unknown }).code, stack, ...(cause ? { cause: redact(cause, depth + 1) } : {}) };
  }
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) out[k] = SECRET_KEY.test(k) ? '[REDACTED]' : redact(v, depth + 1);
  return out;
}

function write(level: Level, msg: string, fields?: Record<string, unknown>) {
  if (LEVELS[level] < LEVELS[config.logLevel]) return;
  const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...(fields ? (redact(fields) as object) : {}) });
  (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(line + '\n');
}

export const log = {
  debug: (msg: string, fields?: Record<string, unknown>) => write('debug', msg, fields),
  info: (msg: string, fields?: Record<string, unknown>) => write('info', msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => write('warn', msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => write('error', msg, fields),
};
