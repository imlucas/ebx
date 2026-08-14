#!/usr/bin/env node
// Assembles the vendor tarball ebx embeds:
//   node_modules/ + package.json   exact npm-installed electron-builder tree
//   node-runtime/bin/node[.exe]    pinned Node, sha-verified from nodejs.org
//   eb-cache/                      electron-builder tool cache, warmed by
//                                  running REAL builds (nsis/AppImage) against
//                                  a fixture — provably correct for this host
//   ebx/fetch.mjs                  the `ebx fetch` helper
//
// Run on the platform the binary targets; each CI matrix runner vendors its own.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pins = JSON.parse(fs.readFileSync(path.join(root, 'VENDOR_VERSIONS.json'), 'utf8'));
const build = path.join(root, 'build');
const vendor = path.join(build, 'vendor');

// Fork support: an optional config (EBX_VENDOR_CONFIG or ./vendor.config.json)
// lets a downstream repo brand its ebx build, pin its own electron-builder,
// and bake in default CLI args (e.g. -c.electronVersion / -c.electronDist
// pointing at the fork's sidecar dist). See docs/FORKS.md.
const configPath = process.env.EBX_VENDOR_CONFIG || path.join(root, 'vendor.config.json');
const forkConfig = fs.existsSync(configPath)
  ? JSON.parse(fs.readFileSync(configPath, 'utf8'))
  : {};
if (forkConfig['electron-builder']) pins['electron-builder'] = forkConfig['electron-builder'];

const plat = process.platform; // darwin | linux | win32
// EBX_TARGET_ARCH allows cross-arch vendoring on macOS via Rosetta (the warm
// build runs the downloaded target-arch node, so toolset detection follows).
const arch = process.env.EBX_TARGET_ARCH || process.arch; // arm64 | x64
const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { stdio: 'inherit', ...opts });

fs.rmSync(vendor, { recursive: true, force: true });
fs.mkdirSync(vendor, { recursive: true });

// 1. The electron-builder tree, exactly as npm lays it down.
console.log(`[vendor] npm install electron-builder@${pins['electron-builder']}`);
fs.writeFileSync(
  path.join(vendor, 'package.json'),
  JSON.stringify({ name: 'ebx-vendor', private: true, dependencies: { 'electron-builder': pins['electron-builder'] } }, null, 2)
);
run('npm', ['install', '--no-audit', '--no-fund', '--omit=dev'], { cwd: vendor, shell: plat === 'win32' });

// 2. Pinned Node runtime, verified against nodejs.org SHASUMS.
const nv = pins.node;
const nodePlat = plat === 'win32' ? 'win' : plat;
const ext = plat === 'win32' ? 'zip' : 'tar.gz';
const distName = `node-v${nv}-${nodePlat}-${arch}`;
const distFile = `${distName}.${ext}`;
console.log(`[vendor] fetch ${distFile}`);
const base = `https://nodejs.org/dist/v${nv}`;
const buf = Buffer.from(await (await fetch(`${base}/${distFile}`)).arrayBuffer());
const shas = await (await fetch(`${base}/SHASUMS256.txt`)).text();
const want = shas.split('\n').find(l => l.endsWith(distFile))?.split(/\s+/)[0];
const got = createHash('sha256').update(buf).digest('hex');
if (!want || got !== want) throw new Error(`node runtime sha mismatch: want ${want} got ${got}`);
const dl = path.join(build, distFile);
fs.writeFileSync(dl, buf);
const unpack = path.join(build, 'node-unpack');
fs.rmSync(unpack, { recursive: true, force: true });
fs.mkdirSync(unpack, { recursive: true });
run('tar', ['-xf', dl, '-C', unpack]); // bsdtar handles .zip on Windows runners
// Full dist, not just the node binary: electron-builder spawns `npm` to
// install/rebuild app dependencies, so npm rides along. Trim what packaging
// never touches (docs, headers, corepack).
const rt = path.join(vendor, 'node-runtime');
fs.cpSync(path.join(unpack, distName), rt, { recursive: true, verbatimSymlinks: true });
for (const trim of ['include', 'share', 'README.md', 'CHANGELOG.md', 'LICENSE',
  path.join('lib', 'node_modules', 'corepack'), path.join('node_modules', 'corepack'),
  'corepack', 'corepack.cmd']) {
  fs.rmSync(path.join(rt, trim), { recursive: true, force: true });
}

// 3. Warm the electron-builder tool cache by building for real.
const ebCache = path.join(vendor, 'eb-cache');
const fixture = path.join(build, 'warm-fixture');
fs.rmSync(fixture, { recursive: true, force: true });
fs.mkdirSync(path.join(fixture, 'src'), { recursive: true });
fs.writeFileSync(path.join(fixture, 'package.json'), JSON.stringify({ name: 'warm', version: '1.0.0', private: true, main: 'src/main.js' }));
fs.writeFileSync(path.join(fixture, 'src', 'main.js'), "const {app}=require('electron');app.whenReady().then(()=>app.quit());\n");
const cli = path.join(vendor, 'node_modules', 'electron-builder', 'cli.js');
// Per-host warm targets: NSIS-from-linux needs wine (upstream signs elevate.exe
// via signtool there), so linux warms only what linux builds offline.
const targets =
  plat === 'win32' ? ['--win', 'nsis']
  : plat === 'linux' ? ['--linux', 'AppImage']
  : ['--win', 'nsis', '--linux', 'AppImage'];
console.log(`[vendor] warming tool cache via real build: ${targets.join(' ')}`);
// Warm with the VENDORED node, not the host's — the shipped combination is
// what gets proven, and under EBX_TARGET_ARCH the target-arch node makes
// toolset arch detection match the target (Rosetta runs it on mac).
const warmNode = plat === 'win32' ? path.join(rt, 'node.exe') : path.join(rt, 'bin', 'node');
run(warmNode, [
  cli, ...targets, '--x64',
  `-c.electronVersion=${pins['warm-electron']}`,
  '-c.appId=dev.ebx.warm', '-c.productName=Warm',
], { cwd: fixture, env: { ...process.env, ELECTRON_BUILDER_CACHE: ebCache } });
// Raw archives are re-downloadable; only the extracted toolsets matter.
fs.rmSync(path.join(ebCache, 'downloads'), { recursive: true, force: true });

// 4. The fetch helper rides along, plus fork default args if configured.
fs.mkdirSync(path.join(vendor, 'ebx'), { recursive: true });
fs.copyFileSync(path.join(root, 'scripts', 'fetch.mjs'), path.join(vendor, 'ebx', 'fetch.mjs'));
if (Array.isArray(forkConfig.defaultArgs) && forkConfig.defaultArgs.length > 0) {
  // One arg per line; the launcher prepends these so user args override them.
  fs.writeFileSync(path.join(vendor, 'ebx', 'default-args'), forkConfig.defaultArgs.join('\n') + '\n');
  console.log(`[vendor] baked default args: ${forkConfig.defaultArgs.join(' ')}`);
}

// 4b. Third-party license manifest: every vendored npm package, the Node
// runtime, and the pre-warmed toolsets. `ebx licenses` prints this file.
console.log('[vendor] collecting third-party licenses');
const entries = [];
const texts = [];
const walk = dir => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const p = path.join(dir, e.name);
    if (e.name.startsWith('@')) { walk(p); continue; }
    const pj = path.join(p, 'package.json');
    if (fs.existsSync(pj)) {
      try {
        const m = JSON.parse(fs.readFileSync(pj, 'utf8'));
        if (m.name && m.version) {
          entries.push({ name: m.name, version: m.version, license: m.license || m.licenses?.[0]?.type || 'UNKNOWN' });
          for (const lf of ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'LICENCE', 'license']) {
            const lp = path.join(p, lf);
            if (fs.existsSync(lp)) {
              texts.push(`\n---\n\n## ${m.name}@${m.version}\n\n\`\`\`\n${fs.readFileSync(lp, 'utf8').trim()}\n\`\`\``);
              break;
            }
          }
        }
      } catch { /* unparseable package.json — skip */ }
    }
    const nested = path.join(p, 'node_modules');
    if (fs.existsSync(nested)) walk(nested);
  }
};
walk(path.join(vendor, 'node_modules'));
entries.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
const seen = new Set();
const unique = entries.filter(e => { const k = `${e.name}@${e.version}`; if (seen.has(k)) return false; seen.add(k); return true; });
const nodeLicense = path.join(unpack, distName, 'LICENSE');
const manifest = [
  '# ebx third-party notices',
  '',
  `This binary embeds and redistributes the following components. Generated at vendor time from the actual embedded tree (electron-builder ${pins['electron-builder']}, Node ${nv}).`,
  '',
  '## Node.js runtime',
  '',
  `Node.js v${nv}, official nodejs.org distribution (including npm). Its LICENSE file (aggregating Node's own third-party notices) is reproduced at the bottom of this document.`,
  '',
  '## Pre-warmed electron-builder toolsets',
  '',
  '| Toolset | License | Source |',
  '|---|---|---|',
  '| NSIS + NSIS resources | zlib/libpng | https://nsis.sourceforge.io |',
  '| 7-Zip (7za) | GNU LGPL + unRAR restriction | https://www.7-zip.org |',
  '| AppImage runtime/tools | MIT | https://github.com/AppImage |',
  '',
  'All fetched from https://github.com/electron-userland/electron-builder-binaries releases, unmodified.',
  '',
  `## npm packages (${unique.length})`,
  '',
  '| Package | Version | License |',
  '|---|---|---|',
  ...unique.map(e => `| ${e.name} | ${e.version} | ${e.license} |`),
  '',
  '# License texts',
  ...texts,
  '\n---\n\n## Node.js\n\n```\n' + (fs.existsSync(nodeLicense) ? fs.readFileSync(nodeLicense, 'utf8').trim() : 'see https://github.com/nodejs/node/blob/main/LICENSE') + '\n```',
].join('\n');
fs.writeFileSync(path.join(vendor, 'ebx', 'THIRD-PARTY.md'), manifest);
console.log(`[vendor] third-party manifest: ${unique.length} packages, ${(manifest.length / 1024).toFixed(0)} KB`);

// 5. Plain tarball; build.rs compresses it (no zstd CLI needed on any host).
const out = path.join(build, 'vendor.tar');
fs.rmSync(out, { force: true });
run('tar', ['-cf', out, '-C', vendor, 'node_modules', 'package.json', 'node-runtime', 'eb-cache', 'ebx']);
console.log(`[vendor] done: ${out} (${(fs.statSync(out).size / 1024 / 1024).toFixed(1)} MB)`);
