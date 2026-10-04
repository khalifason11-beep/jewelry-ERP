// Process helpers for the backup tools: spawn without a shell (no injection, no passwords on the
// command line; libpq reads them from the environment), pipe one process into another, hash files.

import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import path from 'node:path';

export class ToolError extends Error {}

export const bin = (dir: string | undefined, name: string) => (dir ? path.join(dir, name) : name);

function collectStderr(p: ChildProcess, label: string): () => string {
  let err = '';
  p.stderr?.on('data', (d: Buffer) => {
    err += d.toString();
    if (err.length > 8_000) err = err.slice(-8_000);
  });
  return () => `${label}: ${err.trim() || 'failed'}`;
}

function done(p: ChildProcess, label: string, stderr: () => string): Promise<void> {
  return new Promise((resolve, reject) => {
    p.on('error', (e) => reject(new ToolError(`${label} could not be started (${(e as NodeJS.ErrnoException).code ?? e.message}). Is it installed?`)));
    p.on('close', (code) => (code === 0 ? resolve() : reject(new ToolError(stderr()))));
  });
}

/** Run `a | b` (stdout of a into stdin of b) and wait for both. */
export async function pipeline(a: { cmd: string; args: string[]; env: NodeJS.ProcessEnv; label: string }, b: { cmd: string; args: string[]; env: NodeJS.ProcessEnv; label: string }): Promise<void> {
  const pa = spawn(a.cmd, a.args, { env: a.env, stdio: ['ignore', 'pipe', 'pipe'] });
  const pb = spawn(b.cmd, b.args, { env: b.env, stdio: ['pipe', 'ignore', 'pipe'] });
  const ea = collectStderr(pa, a.label);
  const eb = collectStderr(pb, b.label);
  pa.stdout!.pipe(pb.stdin!);
  pb.stdin!.on('error', () => undefined);
  const results = await Promise.allSettled([done(pa, a.label, ea), done(pb, b.label, eb)]);
  const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
  if (failed) throw failed.reason;
}

/** Run one command and wait. */
export async function run(cmd: string, args: string[], env: NodeJS.ProcessEnv, label: string): Promise<void> {
  const p = spawn(cmd, args, { env, stdio: ['ignore', 'ignore', 'pipe'] });
  await done(p, label, collectStderr(p, label));
}

/** Run an operator-supplied shell command (the off-site upload hook); its output goes to ours. */
export async function runShell(command: string, env: NodeJS.ProcessEnv): Promise<void> {
  const p = spawn('/bin/sh', ['-c', command], { env, stdio: ['ignore', 'inherit', 'inherit'] });
  await new Promise<void>((resolve, reject) => {
    p.on('error', (e) => reject(new ToolError(`the upload command could not be started (${e.message})`)));
    p.on('close', (code) => (code === 0 ? resolve() : reject(new ToolError(`the upload command exited with code ${code}`))));
  });
}

export function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(file)
      .on('data', (d) => h.update(d))
      .on('error', reject)
      .on('end', () => resolve(h.digest('hex')));
  });
}
