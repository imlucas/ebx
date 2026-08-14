# ebx supply-chain threat model

- Start Date: 2026-08-14
- RFC PR: (this document; format follows [electron/rfcs](https://github.com/electron/rfcs) 0000-template)
- Reference Implementation: imlucas/ebx (vendor lockfile + release attestations land with this RFC)
- Status: **Proposed**

## Summary

ebx redistributes a build toolchain — an npm-installed electron-builder tree, an official
Node.js runtime, and electron-builder's binary toolsets — as opaque single-file binaries,
built by CI and kept current by an automated release loop. Its entire meaningful risk
surface is therefore supply chain: everything ebx will ever do to a consumer, good or
bad, it does at build time on trusted machines. This RFC enumerates the assets, trust
boundaries, and actors; states which mitigations exist and which are missing; and
commits to the two cheapest high-value fixes (vendor reproducibility, release
provenance) as the reference implementation.

## Motivation

A compromised ebx binary is a compromised *packaging step* for every app built with it —
the position on the dependency graph attackers pay the most for (SolarWinds, the 2025 npm
worm wave). Three properties make ebx's exposure unusual and worth modeling explicitly
rather than by vibes:

1. **Opacity.** Consumers see one binary, not a lockfile. The npm tree inside it is
   invisible to their `npm audit`, Dependabot, and SBOM tooling.
2. **Automation.** The update-watch loop bumps, builds, self-merges, and publishes
   releases with no human in the loop for patch/minor upstream bumps.
3. **Fan-out.** The fork story (docs/FORKS.md) puts ebx sidecars inside an npm package
   every consuming app installs — one poisoned vendor run reaches every repo in a fleet.

## Guide-level explanation

What a consumer trusts when they run ebx, from most to least visible:

| You run | You are trusting |
|---|---|
| `ebx --mac dmg` | the binary you installed = the binary CI built from the tagged commit |
| the embedded tree | the npm registry's content **at the moment CI vendored**, and nodejs.org's SHASUMS |
| the embedded toolsets | electron-builder-binaries releases, pinned by upstream's own checksums |
| `ebx fetch` | the same upstream checksum tables, executed by upstream's own download code |
| the extraction cache | your own `~/.cache/ebx` (same local-trust class as `node_modules`) |

How to verify, once this RFC's reference implementation lands: check the release's
`SHA256SUMS`, verify the GitHub build-provenance attestation
(`gh attestation verify ebx-darwin-universal -R imlucas/ebx`), and — for the paranoid
path — rebuild locally from the same tag with `node scripts/build.mjs`: the committed
vendor lockfile makes the embedded tree reproducible, and the differential CI tier
demonstrates output equivalence against a stock electron-builder at the same pin.

## Reference-level explanation

### Assets

A1 the release binaries · A2 the vendor tree (npm) · A3 the Node runtime · A4 the warmed
toolsets · A5 the repo + workflows (the factory) · A6 the extraction cache on consumer
machines · A7 fork sidecar payloads (`electronDist` + branded ebx in an npm package).

### Trust boundaries and current posture

| # | Boundary | Threat | Today | Gap |
|---|---|---|---|---|
| B1 | npm registry → vendor tree (A2) | malicious/hijacked transitive published between vendor runs | electron-builder version pinned; **transitives float at vendor time** | **No lockfile → not reproducible, and a fresh compromise is silently embedded on the next scheduled rebuild.** Fixed by this RFC: committed `vendor/package-lock.json`, `npm ci` at vendor, refreshed only by the update-watch bump PR where the diff is reviewable. |
| B2 | nodejs.org → runtime (A3) | mirror/CDN tamper | SHA256 verified against SHASUMS256.txt fetched over TLS | SHASUMS itself is unauthenticated (no GPG verify of the release-signer key). Accepted for now; noted under Unresolved. |
| B3 | electron-builder-binaries → toolsets (A4) | tampered NSIS/AppImage/7zip archives | downloads go through upstream's own code with upstream's pinned checksums; warmed **by running real builds**, so a nonfunctional tamper also fails vendor | checksum provenance is upstream's word; same trust as electron-builder itself — acceptable by construction (ebx ≡ electron-builder). |
| B4 | CI → release (A1) | compromised workflow/runner publishes a poisoned binary | private repo; release only via workflows; majors held for human review | **No provenance attestation and no signature on ebx's own binaries** (mac slices are linker-adhoc only). Fixed by this RFC: `actions/attest-build-provenance` on every release artifact; consumer verify via `gh attestation verify`. Signing/notarization of ebx itself: fork CI signs sidecars today (FORKS.md); ebx's own certs are an open question. |
| B5 | update-watch automation (A5) | attacker lands a "bump" that swaps more than the pin | test-then-merge on a 3-OS matrix incl. the **differential tier** (stock-vs-ebx equivalence at the same pin) before self-merge; majors require a human | the bot's merge right is repo-write scoped — repo compromise = factory compromise. Mitigations available (environment protection, tag protection rules) listed under Future. |
| B6 | consumer cache (A6) | local tamper of the extracted tree | content-addressed dir per embedded sha; extract-to-temp+rename | files are not re-verified after extraction — a same-user local attacker can edit the cache. Same class as editing `node_modules`; explicitly out of scope (local user compromise defeats everything at that point). |
| B7 | fork sidecars (A7) | tampered sidecar in the fleet's npm package | registry content-addressing + the fork CI's own signing of sidecars | the fork owns this boundary; FORKS.md instructs signing sidecars with the fork's certs. npm `--provenance` once packages publish. |

### What is deliberately NOT mitigated

- Trust in upstream electron-builder itself: ebx embeds it unmodified; a malicious
  upstream release reaches ebx exactly as it reaches every npm consumer — one release
  later, via a reviewable bump PR, which is *more* friction than `^` ranges give npm users.
- Local-machine compromise (B6): out of scope by the same argument as npm's.

## Drawbacks

The lockfile adds bump-PR churn (every upstream release regenerates it — that is the
point, but it makes diffs bigger). Attestation verification requires `gh`/network at
verify time. A signed-and-notarized ebx would add cert custody burden to a tool whose
pitch is "no toolchain to manage."

## Rationale and alternatives

- **Do nothing** — rejected: B1 is a live, silent-by-design hole; the whole value
  proposition ("one sha-addressed toolchain") is hollow if the sha isn't reproducible.
- **Full SLSA L3 + sigstore now** — deferred, not rejected: attestations get 80% of the
  verification story with one workflow line; sigstore signing and SLSA formalization make
  sense when/if ebx goes public or upstream.
- **Vendor at install time instead of embedding** (let consumers npm-install) — that is
  just npm again; it abandons hermeticity, the product.

## Prior art

esbuild/Biome/Turborepo ship registry-held binaries but keep their (much smaller) deps
vendored in-repo; Volta/proto attest via checksums; **app-builder-bin is the in-family
precedent** — electron-builder itself already asks users to trust prebuilt Go binaries
with no attestation, so ebx-with-attestations is a strictly stronger posture than the
tool it wraps. GitHub artifact attestations + `gh attestation verify` are the current
lowest-friction provenance mechanism for Actions-built artifacts; npm publish
`--provenance` is its registry twin.

## Unresolved questions

- GPG verification of nodejs.org SHASUMS (B2): worth the key-management complexity?
- Should ebx's own binaries be code-signed/notarized (macOS) once distributed beyond the
  fork story, or is attestation + fork-side signing of sidecars the honest layering?
- update-watch hardening: environment protection rules and tag protection before any
  public consumption.

## Future possibilities

SBOM emission (`ebx licenses` already inventories the tree — CycloneDX is a formatting
step); npm `--provenance` on the scaffolded packages; reproducible-build verification as
a CI tier (rebuild from the lockfile on a second runner, diff the vendor tarball);
sigstore bundle publication if ebx goes public or upstream to electron-userland.
