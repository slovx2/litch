// Litch 的 Windows Computer Use 助手。主进程 spawn `litch-computer-use.exe --parent-pid <主进程号>`，
// 连接就是标准输入输出（4 字节大端长度 + JSON-RPC），标准错误只写日志。
// 编成 Windows 子系统：没有控制台窗口（默认终端是 Windows Terminal 时，控制台程序会弹出终端窗口抢前台）。
//
// 纯逻辑的模块（帧、键名、坐标、名单、文字）在任何平台都能编译和跑测试；用到系统接口的在 win/ 下，只在 Windows 上编译。
#![cfg_attr(windows, windows_subsystem = "windows")]
#![cfg_attr(not(windows), allow(dead_code))]

mod shell;
mod copy;
mod geometry;
mod ident;
mod keys;
mod roles;
mod text;
mod tree;
mod wire;

#[cfg(windows)]
mod win;

/// 助手的版本 = Litch 的版本（build.rs 从根目录 package.json 读），主进程握手时比对
pub const VERSION: &str = env!("LITCH_VERSION");

fn main() {
    #[cfg(windows)]
    std::process::exit(win::server::run(std::env::args().collect()));
    #[cfg(not(windows))]
    {
        eprintln!("litch-computer-use {VERSION} only runs on Windows");
        std::process::exit(2);
    }
}
