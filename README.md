# ebx

**electron-builder as a single downloadable binary.** CI images and developer
machines download one file; no Node install, no npm, no 277-package devDependency
tree in any consuming repo.

```bash
ebx --mac dmg          # it is electron-builder's own CLI, passed through
ebx --win nsis --x64   # Windows installers build fine from macOS/Linux
ebx --linux AppImage
```

Proven: on a machine with **no `node` on PATH at all**, a single `ebx` binary
packaged one app for macOS (`.app`, boots), Windows (NSIS installer), and Linux
(AppImage) — with zero tool downloads. The only network fetch was the per-version
Electron dist zip, and `ebx fetch` can pre-seed that too.

## Install

```bash
gh release download --repo imlucas/ebx --pattern 'install.sh' -O - | sh
```

or grab a binary directly from [Releases](../../releases) (assets:
`ebx-darwin-arm64`, `ebx-linux-x64`, `ebx-win32-x64.exe`, `SHA256SUMS`).
A plain-curl installer replaces the `gh`-based one if/when the repo goes public.

## How it works

Vendor-by-extraction, not bundle-by-transformation. JS bundlers (ncc, esbuild,
pkg, Node SEA) transform the module graph, and electron-builder fights that:
lazy `require`s of target modules by computed name, loose assets (NSIS scripts,
templates), and `app-builder-bin`'s prebuilt Go binaries. So ebx transforms
nothing. One zstd tarball inside the binary holds:

| Embedded | What | Why it works |
|---|---|---|
| `node_modules/` | the exact npm-installed electron-builder tree | byte-identical to `npm install`, so upstream behavior is unmodified |
| `node-runtime/` | pinned official Node dist, npm included | machines need no Node; electron-builder's own `npm` spawns resolve here |
| `eb-cache/` | NSIS, NSIS resources, AppImage tool, 7zip | warmed at vendor time by **running real builds**, so it is provably complete per platform |

On first run the tarball extracts (~2 s) to a content-addressed cache
(`~/.cache/ebx/<sha>/`, `%LOCALAPPDATA%\ebx` on Windows; override with
`EBX_CACHE`), then every invocation execs the real `electron-builder` CLI from
that tree with `ELECTRON_BUILDER_CACHE` pointed at the embedded toolsets.
Extraction goes to a temp dir and renames into place, so a killed first run
can't poison the cache.

Still downloaded at runtime, by design (per-project version, too big to embed):

- **Electron dist zip** — pre-seed with `ebx fetch --electron 37.2.4`
- **Windows signing toolset** — pre-seed with `ebx fetch --wincodesign`
  (both use upstream's own download code and checksums)

## Subcommands

| Command | Does |
|---|---|
| `ebx <args>` | passthrough to `electron-builder` CLI — full flag parity |
| `ebx install-app-deps <args>` | passthrough to upstream's `install-app-deps` |
| `ebx fetch --electron <v>` / `--wincodesign` | pre-seed the remaining runtime downloads for offline builds |
| `ebx node <args>` | run the embedded Node (debugging escape hatch) |
| `ebx --ebx-version` | launcher, electron-builder, and Node versions |

## Measured (2026-08-13, M-series macOS)

| | |
|---|---|
| Binary size | ~61 MB (Node runtime ~28 MB, electron-builder tree ~16 MB, warmed toolsets ~15 MB) |
| First run | +2 s one-time extraction |
| Warm `--dir` build of a bare app | ~2 s |
| What a consuming repo declares | nothing |

## Building from source

```bash
node scripts/build.mjs   # vendor (npm install + node dist + warm cache) + cargo build
bash scripts/smoke.sh    # package a bare fixture with the result
```

Vendoring runs real NSIS/AppImage builds to warm the tool cache, so it
downloads one Electron dist. Each platform's binary must be vendored on that
platform (toolsets and optional deps are host-specific) — CI's matrix does
exactly that; see `.github/workflows/build.yml`.

Version pins live in [VENDOR_VERSIONS.json](VENDOR_VERSIONS.json). The
`update-watch` workflow checks npm daily, PRs a bump, builds and smokes the
full matrix against the bump branch, merges only on green, and publishes a
release from the binaries it already tested (`v<electron-builder>-ebx.<n>`).
New electron-builder majors are held as an open PR for human review.

## Honest gaps

- **Code signing paths are not exercised end-to-end** — `ebx fetch
  --wincodesign` warms the toolset and nothing in signing resolves differently,
  but no signed build has been produced through ebx yet.
- **Windows-installer builds from Linux need wine on the system** (upstream signs
  elevate.exe via signtool-under-wine there; macOS uses a native path, so
  NSIS-from-mac works out of the box). The Linux binary embeds the AppImage
  toolchain only.
- **mac x64 has no prebuilt binary** (no free Intel runners); build from source
  on an Intel Mac.
- **Native module rebuilds from source** still need a compiler toolchain on the
  machine — prebuild-first stacks (napi-rs) don't hit this.
- **License aggregation**: the binary redistributes the npm tree and toolsets;
  a bundled third-party license manifest (`ebx licenses`) is future work.
- Rebuilding per electron-builder release means trusting this repo's CI as part
  of your supply chain; releases ship SHA256SUMS, and reproducing a binary
  locally from the same pins is one `node scripts/build.mjs` away.

## License

MIT for ebx itself. The embedded tree is upstream
[electron-builder](https://github.com/electron-userland/electron-builder) (MIT)
and its dependencies, each under its own license; the embedded Node runtime is
the official nodejs.org distribution under its license.
