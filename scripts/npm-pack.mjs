#!/usr/bin/env node
// Assembles the npm distribution from release artifacts:
//   ebx                       root package: bin shim + optionalDependencies
//   @ebx-bin/<platform-arch>  one per prebuilt binary, os/cpu-gated
//
// Usage: node scripts/npm-pack.mjs <artifacts-dir> <version>
//   <artifacts-dir> holds ebx-darwin-arm64, ebx-linux-x64, ebx-win32-x64.exe
//   <version> is the release version, e.g. 26.15.3-ebx.0 (valid semver)
// Output: build/npm/**, ready for `npm publish` per package (root last).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [artifactsDir, version] = process.argv.slice(2);
if (!artifactsDir || !version) {
  console.error('usage: npm-pack.mjs <artifacts-dir> <version>');
  process.exit(2);
}

const PLATFORMS = {
  'darwin-arm64': { os: ['darwin'], cpu: ['arm64'], file: 'ebx-darwin-arm64', bin: 'ebx' },
  'darwin-x64': { os: ['darwin'], cpu: ['x64'], file: 'ebx-darwin-x64', bin: 'ebx' },
  'linux-x64': { os: ['linux'], cpu: ['x64'], file: 'ebx-linux-x64', bin: 'ebx' },
  'linux-arm64': { os: ['linux'], cpu: ['arm64'], file: 'ebx-linux-arm64', bin: 'ebx' },
  'win32-x64': { os: ['win32'], cpu: ['x64'], file: 'ebx-win32-x64.exe', bin: 'ebx.exe' },
};

const out = path.join(root, 'build', 'npm');
fs.rmSync(out, { recursive: true, force: true });

const optional = {};
for (const [key, p] of Object.entries(PLATFORMS)) {
  const src = path.join(artifactsDir, p.file);
  if (!fs.existsSync(src)) continue; // package only what this release built
  const dir = path.join(out, `ebx-bin-${key}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(src, path.join(dir, p.bin));
  fs.chmodSync(path.join(dir, p.bin), 0o755);
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify(
      {
        name: `@ebx-bin/${key}`,
        version,
        description: `ebx prebuilt binary for ${key}`,
        license: 'MIT',
        os: p.os,
        cpu: p.cpu,
        files: [p.bin],
      },
      null,
      2
    )
  );
  optional[`@ebx-bin/${key}`] = version;
  console.log(`[npm-pack] @ebx-bin/${key}@${version}`);
}
if (Object.keys(optional).length === 0) {
  console.error('[npm-pack] no artifacts found — nothing to package');
  process.exit(1);
}

const rootDir = path.join(out, 'ebx');
fs.mkdirSync(path.join(rootDir, 'bin'), { recursive: true });
fs.copyFileSync(path.join(root, 'npm', 'ebx', 'bin', 'ebx.js'), path.join(rootDir, 'bin', 'ebx.js'));
fs.copyFileSync(path.join(root, 'README.md'), path.join(rootDir, 'README.md'));
fs.writeFileSync(
  path.join(rootDir, 'package.json'),
  JSON.stringify(
    {
      name: 'ebx',
      version,
      description: 'electron-builder as a single downloadable binary',
      license: 'MIT',
      repository: { type: 'git', url: 'git+https://github.com/imlucas/ebx.git' },
      bin: { ebx: 'bin/ebx.js' },
      files: ['bin'],
      optionalDependencies: optional,
    },
    null,
    2
  )
);
console.log(`[npm-pack] ebx@${version} (root) → ${out}`);
console.log('[npm-pack] publish order: @ebx-bin/* first, then ebx');
