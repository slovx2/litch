// 助手的版本号取 Litch 根目录 package.json 的 version（主进程握手时要求两者一致），编译时写进环境变量 LITCH_VERSION。
use std::fs;
use std::path::Path;

fn main() {
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../package.json");
    println!("cargo:rerun-if-changed={}", manifest.display());
    let text = fs::read_to_string(&manifest).unwrap_or_default();
    let version = text
        .split("\"version\"")
        .nth(1)
        .and_then(|rest| rest.split('"').nth(1))
        .unwrap_or("0.0.0")
        .to_string();
    println!("cargo:rustc-env=LITCH_VERSION={version}");
}
