#!/usr/bin/env node
// Full build: vendor (unless build/vendor.tar exists and --skip-vendor),
// then cargo build --release with the tarball + version metadata baked in.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pins = JSON.parse(fs.readFileSync(path.join(root, 'VENDOR_VERSIONS.json'), 'utf8'));
const tarball = path.join(root, 'build', 'vendor.tar');

if (!process.argv.includes('--skip-vendor') || !fs.existsSync(tarball)) {
  execFileSync(process.execPath, [path.join(root, 'scripts', 'vendor.mjs')], { stdio: 'inherit' });
}

const cargo = JSON.parse(
  execFileSync('cargo', ['metadata', '--no-deps', '--format-version', '1'], { cwd: root }).toString()
);
const configPath = process.env.EBX_VENDOR_CONFIG || path.join(root, 'vendor.config.json');
const forkConfig = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, 'utf8')) : {};
const meta = [
  `ebx ${cargo.packages[0].version}${forkConfig.label ? ` (${forkConfig.label})` : ''}`,
  `electron-builder ${forkConfig['electron-builder'] || pins['electron-builder']}`,
  `node ${pins.node}`,
  `host ${process.platform}-${process.arch}`,
].join('\n');

execFileSync('cargo', ['build', '--release'], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, VENDOR_TAR: tarball, EBX_META: meta },
});
const bin = path.join(root, 'target', 'release', process.platform === 'win32' ? 'ebx.exe' : 'ebx');
console.log(`[build] ${bin} (${(fs.statSync(bin).size / 1024 / 1024).toFixed(1)} MB)`);
