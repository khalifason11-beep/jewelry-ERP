// The real server as a child process on a test database (SAFE-1): for the shutdown and log tests. `node --import tsx`
// (not npx/tsx, which wrap the server in a second process): a signal must reach the server itself. Its stdout and
// stderr are kept, so a test can read every log line the server wrote.

import { spawn, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';

export interface ServerProcess {
  child: ChildProcess;
  base: string;
  exited: Promise<number | null>;
  /** Everything the server wrote to stdout and stderr so far. */
  output: () => string;
}

const freePort = () =>
  new Promise<number>((res) => {
    const s = net.createServer().listen(0, () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => res(p));
    });
  });

export async function startServer(databaseUrl: string, env: Record<string, string> = {}): Promise<ServerProcess> {
  const port = await freePort();
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
    cwd: path.resolve(__dirname, '../..'),
    env: { ...process.env, APP_MODE: 'demo', DATABASE_URL: databaseUrl, PORT: String(port), LOG_LEVEL: 'warn', VITEST: '', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout!.on('data', (d) => (out += d));
  child.stderr!.on('data', (d) => (out += d));
  const exited = new Promise<number | null>((res) => child.on('exit', (code) => res(code)));
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 200; i++) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) return { child, base, exited, output: () => out };
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  child.kill('SIGKILL');
  throw new Error(`the server did not start:\n${out}`);
}
