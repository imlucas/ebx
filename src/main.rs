// ebx: electron-builder as a single downloadable binary.
//
// Architecture: vendor-by-extraction, not bundle-by-transformation. The exact
// npm-installed electron-builder tree, a pinned Node runtime, and a pre-warmed
// electron-builder tool cache (NSIS, AppImage, 7zip — warmed by running real
// builds at vendor time) are embedded as one zstd tarball, extracted
// byte-identical to a content-addressed cache on first run, and executed
// unmodified. No module-graph rewriting, so upstream's dynamic requires, lazy
// target loading, assets, and platform binaries all behave exactly as an npm
// install would.
//
// Subcommands:
//   ebx <electron-builder args...>   passthrough to electron-builder's own CLI
//   ebx install-app-deps <args...>   passthrough to install-app-deps
//   ebx fetch [--electron <v>] [--wincodesign]
//                                    pre-seed per-version runtime downloads
//   ebx node <args...>               run the embedded Node (debugging escape hatch)
//   ebx --ebx-version                launcher + vendored component versions

use sha2::{Digest, Sha256};
use std::path::PathBuf;
use std::process::Command;

static VENDOR: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/vendor.tar.zst"));
static META: &str = env!("EBX_META");

fn cache_root() -> PathBuf {
    if let Ok(dir) = std::env::var("EBX_CACHE") {
        return PathBuf::from(dir);
    }
    #[cfg(windows)]
    {
        let base = std::env::var("LOCALAPPDATA").expect("LOCALAPPDATA not set");
        PathBuf::from(base).join("ebx")
    }
    #[cfg(not(windows))]
    {
        let home = std::env::var("HOME").expect("HOME not set");
        PathBuf::from(home).join(".cache").join("ebx")
    }
}

// The embedded runtime keeps the official dist layout: node + npm live in
// bin/ on unix and at the dist root on Windows.
fn node_dir(dest: &std::path::Path) -> PathBuf {
    if cfg!(windows) {
        dest.join("node-runtime")
    } else {
        dest.join("node-runtime").join("bin")
    }
}

fn node_bin(dest: &std::path::Path) -> PathBuf {
    let name = if cfg!(windows) { "node.exe" } else { "node" };
    node_dir(dest).join(name)
}

fn ensure_extracted() -> PathBuf {
    let digest = Sha256::digest(VENDOR);
    let tag = hex(&digest[..8]);
    let dest = cache_root().join(&tag);
    let ready = dest.join(".ok");
    if ready.exists() {
        return dest;
    }
    eprintln!(
        "[ebx] first run: extracting vendored toolchain ({} MB) -> {}",
        VENDOR.len() / (1024 * 1024),
        dest.display()
    );
    let started = std::time::Instant::now();
    // Extract to a temp sibling then rename, so a killed first run never
    // leaves a half-extracted tree that later runs trust.
    let tmp = cache_root().join(format!(".{tag}.partial.{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&tmp);
    std::fs::create_dir_all(&tmp).expect("create cache dir");
    let decoder = zstd::Decoder::new(VENDOR).expect("zstd decoder");
    let mut archive = tar::Archive::new(decoder);
    archive.set_preserve_permissions(true);
    archive.unpack(&tmp).expect("extract vendor tarball");
    std::fs::write(tmp.join(".ok"), &tag).expect("write ready marker");
    match std::fs::rename(&tmp, &dest) {
        Ok(_) => {}
        Err(_) if ready.exists() => {
            // A concurrent run won the race; use theirs.
            let _ = std::fs::remove_dir_all(&tmp);
        }
        Err(e) => panic!("finalize cache: {e}"),
    }
    eprintln!("[ebx] extracted in {:.1}s", started.elapsed().as_secs_f32());
    dest
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();

    if args.first().map(String::as_str) == Some("--ebx-version") {
        println!("{META}");
        return;
    }

    let dest = ensure_extracted();
    let node = node_bin(&dest);

    // Point electron-builder at the embedded, pre-warmed tool cache unless the
    // user routed it elsewhere themselves.
    let eb_cache = dest.join("eb-cache");
    let mut cmd = Command::new(&node);
    if std::env::var_os("ELECTRON_BUILDER_CACHE").is_none() && eb_cache.is_dir() {
        cmd.env("ELECTRON_BUILDER_CACHE", &eb_cache);
    }

    // Put the embedded runtime first on the child's PATH so electron-builder's
    // own `npm`/`node` spawns resolve to it — machines with no Node install at
    // all stay fully supported.
    let sep = if cfg!(windows) { ";" } else { ":" };
    let inherited = std::env::var("PATH").unwrap_or_default();
    cmd.env(
        "PATH",
        format!("{}{sep}{inherited}", node_dir(&dest).display()),
    );

    match args.first().map(String::as_str) {
        Some("node") => {
            cmd.args(&args[1..]);
        }
        Some("fetch") => {
            cmd.arg(dest.join("ebx").join("fetch.mjs")).args(&args[1..]);
        }
        Some("install-app-deps") => {
            cmd.arg(dest.join("node_modules").join("electron-builder").join("install-app-deps.js"))
                .args(&args[1..]);
        }
        _ => {
            cmd.arg(dest.join("node_modules").join("electron-builder").join("cli.js"))
                .args(&args);
        }
    }

    let status = cmd.status().unwrap_or_else(|e| {
        panic!("spawn embedded node at {}: {e}", node.display());
    });
    std::process::exit(status.code().unwrap_or(1));
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
