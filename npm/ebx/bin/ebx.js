#!/usr/bin/env node
// npm shim: resolves the platform binary from optionalDependencies
// (@ebx-bin/<platform>-<arch>) and execs it. No postinstall, no downloads —
// the binary is IN the resolved package, esbuild-style, so offline and
// hermetic installs work from any registry mirror.
'use strict';
const { spawnSync } = require('child_process');
const path = require('path');

const key = `${process.platform}-${process.arch}`;
const pkg = `@ebx-bin/${key}`;
let bin;
try {
  const file = process.platform === 'win32' ? 'ebx.exe' : 'ebx';
  bin = path.join(path.dirname(require.resolve(`${pkg}/package.json`)), file);
} catch {
  console.error(
    `ebx: no binary package for ${key}.\n` +
      `Expected optional dependency ${pkg} — either this platform has no prebuilt ebx yet, ` +
      `or your package manager skipped optional dependencies (npm: do not use --no-optional).`
  );
  process.exit(1);
}

const r = spawnSync(bin, process.argv.slice(2), { stdio: 'inherit' });
if (r.error) throw r.error;
process.exit(r.status === null ? 1 : r.status);
