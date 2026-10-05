#!/usr/bin/env node
// Guard against npm bug #4828: a package-lock.json generated on one OS can lack the optional native
// binaries of the others, and `npm install` then silently skips them (e.g. on Windows the backend
// crashes with "Cannot find native binding" because @node-rs/argon2-win32-x64-msvc is missing).
//
// For every package in the lockfile that ships per-platform binaries as optionalDependencies
// (@node-rs/argon2, rollup, esbuild, lightningcss, @tailwindcss/oxide, …) this checks that the
// lockfile has a resolved entry (URL + integrity) for each target platform:
//   win32-x64 (msvc), linux-x64 (gnu), darwin-arm64, darwin-x64
//
//   node scripts/check-lockfile-platforms.mjs [path/to/package-lock.json]
//
// Exit code 1 lists what is missing. Remedy: delete node_modules and package-lock.json, run
// `npm install` (npm 10+ then records every platform), commit the new lockfile.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const lockPath = path.resolve(process.argv[2] ?? path.join(root, 'package-lock.json'));
const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
const packages = lock.packages ?? {};

/** Target platforms, the optional-dependency names that serve them (preferred first), os/cpu/libc. */
const TARGETS = [
  { label: 'win32-x64 (msvc)', names: [/-win32-x64-msvc$/, /[/-]win32-x64$/], os: 'win32', cpu: 'x64' },
  { label: 'linux-x64 (gnu)', names: [/-linux-x64-gnu$/, /[/-]linux-x64$/], os: 'linux', cpu: 'x64', libc: 'glibc' },
  { label: 'darwin-arm64', names: [/[/-]darwin-arm64$/], os: 'darwin', cpu: 'arm64' },
  { label: 'darwin-x64', names: [/[/-]darwin-x64$/], os: 'darwin', cpu: 'x64' },
];
const PLATFORM_DEP = /(win32|linux|darwin|android|freebsd|openbsd|netbsd|sunos|aix|openharmony)-/;

/** Node's resolution from a package's directory: nearest node_modules/<name> going up. */
function resolveEntry(fromKey, name) {
  let dir = fromKey;
  for (;;) {
    const key = `${dir ? `${dir}/` : ''}node_modules/${name}`;
    if (packages[key]) return { key, entry: packages[key] };
    if (!dir) return null;
    const i = dir.lastIndexOf('/node_modules/');
    dir = i === -1 ? '' : dir.slice(0, i);
  }
}

const problems = [];
let nativeCount = 0;
for (const [key, pkg] of Object.entries(packages)) {
  const optional = Object.keys(pkg.optionalDependencies ?? {}).filter((d) => PLATFORM_DEP.test(d));
  if (optional.length < 2) continue; // not a per-platform native package
  nativeCount += 1;
  const name = key.replace(/^.*node_modules\//, '');
  for (const target of TARGETS) {
    // The binary the package itself declares for this platform (first matching pattern wins).
    let declared = null;
    for (const re of target.names) {
      declared = optional.find((d) => re.test(d));
      if (declared) break;
    }
    if (!declared) {
      if (target.os === 'win32') problems.push(`${name}@${pkg.version}: declares no ${target.label} binary`);
      continue;
    }
    const found = resolveEntry(key, declared);
    if (!found) {
      problems.push(`${name}@${pkg.version}: lockfile has no entry for ${declared} (${target.label})`);
      continue;
    }
    const e = found.entry;
    if (!e.resolved || !e.integrity) problems.push(`${found.key}: no resolved URL / integrity`);
    if (e.os && !e.os.includes(target.os)) problems.push(`${found.key}: os ${e.os} does not include ${target.os}`);
    if (e.cpu && !e.cpu.includes(target.cpu)) problems.push(`${found.key}: cpu ${e.cpu} does not include ${target.cpu}`);
    if (target.libc && e.libc && !e.libc.includes(target.libc)) problems.push(`${found.key}: libc ${e.libc} does not include ${target.libc}`);
  }
}

if (problems.length) {
  console.error(`package-lock.json lacks native binaries for some platforms (${path.relative(root, lockPath) || lockPath}):`);
  for (const p of problems) console.error(`  - ${p}`);
  console.error('Fix: delete node_modules and package-lock.json, run `npm install` with npm 10+, and commit the new lockfile.');
  process.exit(1);
}
console.log(`lockfile platforms OK: ${nativeCount} native package(s) carry win32-x64, linux-x64, darwin-arm64 and darwin-x64 binaries.`);
