#!/usr/bin/env node
// `ebx fetch` — pre-seed the per-version runtime downloads that can't be
// embedded (they vary per project), so subsequent builds run without network.
//
//   ebx fetch --electron 37.2.4 [--electron 38.0.0 ...]
//       warms the Electron dist cache by running a real `pack --dir` of a
//       throwaway fixture at that version (upstream's own download path).
//   ebx fetch --wincodesign
//       warms the Windows signing toolset for this host via upstream's
//       binDownload (same checksums, same cache layout).
//
// Runs with ELECTRON_BUILDER_CACHE already pointed at ebx's embedded cache by
// the launcher; fetched extras land beside the embedded toolsets. Note they
// live under the current ebx version's content-addressed dir, so a new ebx
// release starts warm for tools but needs re-fetching of these extras.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const vendorRoot = path.resolve(here, '..');
const require = createRequire(path.join(vendorRoot, 'package.json'));

const args = process.argv.slice(2);
const electrons = [];
let winCodeSign = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--electron') electrons.push(args[++i]);
  else if (args[i] === '--wincodesign') winCodeSign = true;
  else {
    console.error(`ebx fetch: unknown arg ${args[i]}`);
    console.error('usage: ebx fetch [--electron <version>]... [--wincodesign]');
    process.exit(2);
  }
}
if (electrons.length === 0 && !winCodeSign) {
  console.error('usage: ebx fetch [--electron <version>]... [--wincodesign]');
  process.exit(2);
}

for (const version of electrons) {
  console.log(`[ebx fetch] warming electron ${version} dist cache`);
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'ebx-fetch-'));
  fs.mkdirSync(path.join(fixture, 'src'), { recursive: true });
  fs.writeFileSync(path.join(fixture, 'package.json'), JSON.stringify({ name: 'fetch', version: '1.0.0', private: true, main: 'src/main.js' }));
  fs.writeFileSync(path.join(fixture, 'src', 'main.js'), "const {app}=require('electron');app.whenReady().then(()=>app.quit());\n");
  execFileSync(process.execPath, [
    path.join(vendorRoot, 'node_modules', 'electron-builder', 'cli.js'),
    '--dir', `-c.electronVersion=${version}`, '-c.appId=dev.ebx.fetch', '-c.productName=Fetch',
    ...(process.platform === 'darwin' ? ['-c.mac.identity=null'] : []),
  ], { cwd: fixture, stdio: 'inherit' });
  fs.rmSync(fixture, { recursive: true, force: true });
}

if (winCodeSign) {
  const { wincodesignChecksums } = require('app-builder-lib/out/toolsets/windows');
  const { getBinFromUrl } = require('app-builder-lib/out/binDownload');
  // The actual signing path still reaches for the LEGACY winCodeSign-2.6.0
  // archive (observed empirically: a CSC_LINK NSIS build from mac downloaded it
  // even with win-codesign@1.1.0 warmed) — warm it via upstream's own helper.
  try {
    const { downloadBuilderToolset } = require('app-builder-lib/out/util/electronGet');
    console.log('[ebx fetch] warming legacy winCodeSign-2.6.0');
    await downloadBuilderToolset({
      releaseName: 'winCodeSign-2.6.0',
      filenameWithExt: 'winCodeSign-2.6.0.7z',
      checksums: { 'winCodeSign-2.6.0.7z': 'cdaec7154dda7cc31f88d886e2489379a0625a737d610b5ae7f62a12f16743a4' },
    });
  } catch (e) {
    console.warn(`[ebx fetch] legacy winCodeSign warm failed (${e.message}); continuing`);
  }
  const versions = Object.keys(wincodesignChecksums).filter(v => v !== '0.0.0').sort();
  const version = versions[versions.length - 1];
  const files = wincodesignChecksums[version];
  const hostKey = {
    'darwin-arm64': 'win-codesign-darwin-arm64.zip',
    'darwin-x64': 'win-codesign-darwin-x86_64.zip',
    'linux-x64': 'win-codesign-linux-amd64.zip',
    'linux-arm64': 'win-codesign-linux-arm64.zip',
    'win32-x64': 'win-codesign-windows-x64.zip',
  }[`${process.platform}-${process.arch}`];
  const wanted = [hostKey, ...(process.platform === 'win32' ? ['rcedit-windows-2_0_0.zip', 'windows-kits-bundle-10_0_26100_0.zip'] : [])]
    .filter(f => f && files[f]);
  for (const file of wanted) {
    console.log(`[ebx fetch] warming win-codesign@${version} ${file}`);
    await getBinFromUrl(`win-codesign@${version}`, file, files[file]);
  }
}
console.log('[ebx fetch] done');
