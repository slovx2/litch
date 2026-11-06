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
    let version = setting("CU_HELPER_VERSION", &version);
    println!("cargo:rustc-env=LITCH_VERSION={version}");
    for (name, default) in [
        ("CU_HOST_PRODUCT", "Litch"),
        ("CU_HOST_REGISTRY_KEY", r"Software\Microsoft\Windows\CurrentVersion\Uninstall\{86165537-655A-4F60-847F-94A1A6C622F4}_is1"),
        ("CU_HOST_EXECUTABLE", "Litch.exe"),
        ("CU_HOST_ISOLATION_KEYS", "LITCH_PROFILE;LITCH_MOCK"),
    ] {
        let value = setting(name, default);
        println!("cargo:rustc-env={name}={value}");
    }
}

// 仅构建期读取，编译进组件；模型/运行时环境不能改变受保护目标。
fn setting(name: &str, default: &str) -> String {
    println!("cargo:rerun-if-env-changed={name}");
    let value = std::env::var(name).unwrap_or_else(|_| default.to_string());
    assert!(!value.is_empty() && !value.chars().any(char::is_control), "invalid build identity: {name}");
    value
}
