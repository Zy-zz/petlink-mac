use petlink::updater::{unpack, verify_bundle};
fn main() {
    let args: Vec<_> = std::env::args().collect();
    let dir = tempfile::tempdir().unwrap();
    let candidate = unpack(std::path::Path::new(&args[1]), dir.path()).unwrap();
    let signed = verify_bundle(&candidate, &args[3], std::path::Path::new(&args[2])).unwrap();
    println!("actual update ZIP verified; Developer ID signed={signed}");
}
