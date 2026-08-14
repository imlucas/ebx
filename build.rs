// Compresses the vendor tarball at build time so no host needs a zstd CLI.
// VENDOR_TAR points at the plain tar produced by scripts/vendor.mjs.
use std::io::Write;

fn main() {
    println!("cargo:rerun-if-env-changed=VENDOR_TAR");
    println!("cargo:rerun-if-env-changed=EBX_META");
    let tar = std::env::var("VENDOR_TAR").expect(
        "VENDOR_TAR not set — build via `node scripts/build.mjs`, not bare cargo",
    );
    println!("cargo:rerun-if-changed={tar}");
    let out = std::path::PathBuf::from(std::env::var("OUT_DIR").unwrap()).join("vendor.tar.zst");
    let data = std::fs::read(&tar).expect("read vendor tar");
    let file = std::fs::File::create(&out).expect("create compressed vendor");
    let mut enc = zstd::Encoder::new(file, 9).expect("zstd encoder");
    enc.multithread(num_threads()).ok();
    enc.write_all(&data).expect("compress vendor");
    enc.finish().expect("finish compression").sync_all().ok();
}

fn num_threads() -> u32 {
    std::thread::available_parallelism().map(|n| n.get() as u32).unwrap_or(1)
}
