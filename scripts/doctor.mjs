#!/usr/bin/env node
// `ebx doctor` — will a build work on this box, and for which targets?
// Informational by design: `ok` / `warn` / `fail` per check, exit 1 only when
// something that blocks every build is broken. Runs on the embedded Node.
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const vendorRoot = path.resolve(here, '..');
const require = createRequire(path.join(vendorRoot, 'package.json'));

let failures = 0;
const report = (level, name, detail) => {
  if (level === 'fail') failures++;
  console.log(`${level.padEnd(4)} ${name.padEnd(28)} ${detail}`);
};

// Toolchain integrity: the embedded tree resolves and reports itself.
try {
  const eb = require('electron-builder/package.json').version;
  report('ok', 'embedded electron-builder', eb);
} catch (e) {
  report('fail', 'embedded electron-builder', `unresolvable: ${e.message}`);
}
report('ok', 'embedded node', `${process.version} (${process.platform}-${process.arch})`);

// Cache: writable, and which toolsets are pre-warmed.
const ebCache = process.env.ELECTRON_BUILDER_CACHE;
if (ebCache && fs.existsSync(ebCache)) {
  const toolsets = fs.readdirSync(ebCache).filter(d => d !== 'downloads' && !d.startsWith('._'));
  report('ok', 'tool cache', `${toolsets.join(', ') || '(empty)'}`);
} else {
  report('warn', 'tool cache', 'not pre-warmed; toolsets will download on demand');
}
try {
  const probe = path.join(os.tmpdir(), `ebx-doctor-${process.pid}`);
  fs.writeFileSync(probe, 'x');
  fs.rmSync(probe);
  report('ok', 'temp dir writable', os.tmpdir());
} catch (e) {
  report('fail', 'temp dir writable', e.message);
}

// Electron dist cache: what's already local (hermetic builds need either this
// or -c.electronDist).
const electronCache =
  process.env.ELECTRON_CACHE ||
  (process.platform === 'darwin'
    ? path.join(os.homedir(), 'Library', 'Caches', 'electron')
    : process.platform === 'win32'
      ? path.join(process.env.LOCALAPPDATA || os.homedir(), 'electron', 'Cache')
      : path.join(os.homedir(), '.cache', 'electron'));
if (fs.existsSync(electronCache)) {
  const zips = [];
  for (const d of fs.readdirSync(electronCache)) {
    try { zips.push(...fs.readdirSync(path.join(electronCache, d)).filter(f => f.startsWith('electron-v') && f.endsWith('.zip'))); } catch { /* flat cache entries */ }
  }
  report(zips.length ? 'ok' : 'warn', 'electron dist cache', zips.length ? zips.sort().join(', ') : 'empty — first build downloads its Electron (or pass -c.electronDist)');
} else {
  report('warn', 'electron dist cache', 'empty — first build downloads its Electron (or pass -c.electronDist)');
}

// Platform-target capability checks.
if (process.platform === 'darwin') {
  const ids = spawnSync('security', ['find-identity', '-v', '-p', 'codesigning'], { encoding: 'utf8' });
  const n = (ids.stdout?.match(/\d+ valid identities found/) || [''])[0] || '0 valid identities';
  report(/^0 /.test(n) ? 'warn' : 'ok', 'mac signing identities', `${n} (unsigned builds: -c.mac.identity=null)`);
  const rosetta = spawnSync('arch', ['-x86_64', '/usr/bin/true']).status === 0;
  report(rosetta ? 'ok' : 'warn', 'rosetta', rosetta ? 'x64/universal builds supported on this arm64 host' : 'absent — x64 slices need an Intel host');
  report('ok', 'windows targets from mac', 'NSIS toolchain embedded; signing via CSC_LINK works cross-platform');
}
if (process.platform === 'linux') {
  const wine = spawnSync('wine', ['--version'], { encoding: 'utf8' }).status === 0;
  report(wine ? 'ok' : 'warn', 'wine', wine ? 'windows-installer targets available' : 'absent — NSIS-from-linux needs wine (upstream signs elevate.exe through it)');
}

// Network: not required when caches/electronDist cover the build, so warn-only.
try {
  execFileSync(process.execPath, ['-e', `
    fetch('https://github.com', { method: 'HEAD', signal: AbortSignal.timeout(4000) })
      .then(() => process.exit(0), () => process.exit(1));
  `], { stdio: 'ignore' });
  report('ok', 'network (github.com)', 'reachable');
} catch {
  report('warn', 'network (github.com)', 'unreachable — builds still work with warm caches + -c.electronDist');
}

process.exit(failures > 0 ? 1 : 0);
