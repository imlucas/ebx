#!/usr/bin/env node
// Builds a UNIVERSAL macOS ebx: two complete single-arch binaries (each slice
// embeds its own arch's vendor payload — node runtime and warmed toolsets are
// arch-specific) glued with lipo. Roughly 2x the size; runs natively on both
// Intel and Apple Silicon. Requires Rosetta (the x64 warm build runs under it)
// and `rustup target add x86_64-apple-darwin`.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'darwin') {
  console.error('universal-mac: macOS only');
  process.exit(2);
}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const run = (cmd, args, env = {}) =>
  execFileSync(cmd, args, { cwd: root, stdio: 'inherit', env: { ...process.env, ...env } });

const TRIPLES = { arm64: 'aarch64-apple-darwin', x64: 'x86_64-apple-darwin' };
const slices = [];
for (const [arch, triple] of Object.entries(TRIPLES)) {
  console.log(`[universal] vendor + build ${arch}`);
  run(process.execPath, [path.join(root, 'scripts', 'vendor.mjs')], { EBX_TARGET_ARCH: arch });
  run('rustup', ['target', 'add', triple]);
  // Reuse build.mjs metadata logic inline: cargo with the arch's fresh tar.
  const pins = JSON.parse(fs.readFileSync(path.join(root, 'VENDOR_VERSIONS.json'), 'utf8'));
  const configPath = process.env.EBX_VENDOR_CONFIG || path.join(root, 'vendor.config.json');
  const forkConfig = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, 'utf8')) : {};
  const cargoMeta = JSON.parse(execFileSync('cargo', ['metadata', '--no-deps', '--format-version', '1'], { cwd: root }).toString());
  const meta = [
    `ebx ${cargoMeta.packages[0].version}${forkConfig.label ? ` (${forkConfig.label})` : ''}`,
    `electron-builder ${forkConfig['electron-builder'] || pins['electron-builder']}`,
    `node ${pins.node}`,
    `host darwin-universal (${arch} slice)`,
  ].join('\n');
  run('cargo', ['build', '--release', '--target', triple], {
    VENDOR_TAR: path.join(root, 'build', 'vendor.tar'),
    EBX_META: meta,
  });
  slices.push(path.join(root, 'target', triple, 'release', 'ebx'));
}

const out = path.join(root, 'target', 'ebx-darwin-universal');
run('lipo', ['-create', '-output', out, ...slices]);
run('lipo', ['-archs', out]);
console.log(`[universal] ${out} (${(fs.statSync(out).size / 1024 / 1024).toFixed(1)} MB)`);
