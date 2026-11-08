// 宿主在构建时提供身份和握手版本；独立源码不读取产品目录，也不默认信任 Litch。

fn main() {
    let version = setting("CU_HELPER_VERSION");
    println!("cargo:rustc-env=LITCH_VERSION={version}");
    for name in [
        "CU_HOST_PRODUCT",
        "CU_HOST_REGISTRY_KEY",
        "CU_HOST_EXECUTABLE",
        "CU_HOST_ISOLATION_KEYS",
    ] {
        let value = setting(name);
        println!("cargo:rustc-env={name}={value}");
    }
}

// 仅构建期读取，编译进组件；模型/运行时环境不能改变受保护目标。
fn setting(name: &str) -> String {
    println!("cargo:rerun-if-env-changed={name}");
    let value = std::env::var(name).unwrap_or_else(|_| panic!("host must set {name} at build time"));
    assert!(!value.is_empty() && !value.chars().any(char::is_control), "invalid build identity: {name}");
    value
}
