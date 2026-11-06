// 进程的骨架：参数、单实例、DPI、COM。读线程即时处理取消，其余请求在主线程依次执行；应答和通知写标准输出。
// 退出的几种情况：标准输入读到结尾、父进程没了（--parent-pid）、60 秒没有请求、主进程发 shutdown。
use super::engine::Engine;
use super::system::{self, log};
use crate::{action::{Actions, Scope}, dispatch, wire};
use serde_json::Value;
use std::io::{self, BufReader, BufWriter, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use windows::Win32::Foundation::{WAIT_OBJECT_0, WAIT_TIMEOUT};
use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};
use windows::Win32::System::Threading::{OpenProcess, WaitForSingleObject, INFINITE, PROCESS_SYNCHRONIZE};
use windows::Win32::UI::HiDpi::{SetProcessDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2};

/// 多久没有请求就自己退出
const IDLE_EXIT: Duration = Duration::from_secs(60);

static OUT: Mutex<Option<BufWriter<io::Stdout>>> = Mutex::new(None);
static LAST_REQUEST: Mutex<Option<Instant>> = Mutex::new(None);
static BUSY: AtomicBool = AtomicBool::new(false);
static ACTIONS: OnceLock<Actions> = OnceLock::new();

pub fn actions() -> &'static Actions { ACTIONS.get_or_init(Actions::default) }

/// 往标准输出写一帧（应答和通知共用，加锁）
fn send(value: &Value) {
    let mut out = OUT.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(writer) = out.as_mut() {
        if let Err(error) = wire::write_frame(writer, value) {
            log(format!("写标准输出失败：{error}；退出"));
            std::process::exit(0);
        }
    }
}

/// 发通知给主进程（钩子线程也调）
pub fn notify(method: &str, params: Value) {
    send(&wire::notification(method, params));
}

fn usage() -> i32 {
    log("用法：litch-computer-use.exe --parent-pid <主进程号>");
    2
}

pub fn run(args: Vec<String>) -> i32 {
    let mut parent: Option<u32> = None;
    let mut i = 1;
    while i < args.len() {
        match args[i].as_str() {
            "--parent-pid" => {
                let Some(pid) = args.get(i + 1).and_then(|s| s.parse().ok()) else { return usage() };
                parent = Some(pid);
                i += 2;
            }
            "--version" => {
                // Windows 子系统没有控制台，版本号写到标准输出给调用方读
                let _ = writeln!(io::stdout(), "{}", crate::VERSION);
                return 0;
            }
            _ => return usage(),
        }
    }
    unsafe {
        let _ = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
    }
    let Some(_instance) = system::single_instance() else {
        log("已经有一个助手在跑（同一用户的另一个 Litch 起的），这个退出");
        return 3;
    };
    *OUT.lock().unwrap_or_else(|e| e.into_inner()) = Some(BufWriter::new(io::stdout()));
    log(format!(
        "助手启动：版本 {}，进程 {}，父进程 {:?}，完整性 {}",
        crate::VERSION,
        std::process::id(),
        parent,
        system::integrity_label(system::own_integrity())
    ));
    if let Some(pid) = parent {
        watch_parent(pid);
    }
    watch_idle();

    let mut engine = Engine::new(parent);
    let (queue, requests) = mpsc::channel();
    let reader = std::thread::spawn(move || {
        dispatch::read_requests(&mut BufReader::new(io::stdin()), actions(), queue, send)
    });
    for request in requests {
        let dispatch::Request { id, method, params, action } = request;
        BUSY.store(true, Ordering::SeqCst);
        let started = Instant::now();
        let _scope = Scope::enter(action);
        let outcome = crate::action::check().and_then(|()| engine.handle(&method, &params));
        *LAST_REQUEST.lock().unwrap_or_else(|e| e.into_inner()) = Some(Instant::now());
        BUSY.store(false, Ordering::SeqCst);
        match outcome {
            Ok(result) => { if let Some(id) = &id { send(&wire::response(id, result)); } }
            Err(error) => {
                log(format!("{method} 失败（{} ms）：{error}", started.elapsed().as_millis()));
                if let Some(id) = &id { send(&wire::error_response(id, &error)); }
            }
        }
        if method == "shutdown" {
            log("主进程要求退出");
            return 0;
        }
    }
    match reader.join() {
        Ok(Ok(())) => { log("标准输入结束，退出"); 0 }
        other => { log(format!("读请求出错：{other:?}；退出")); 1 }
    }
}

/// 父进程没了就退出（作业对象之外的兜底）
fn watch_parent(pid: u32) {
    let handle = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, false, pid) };
    let Ok(handle) = handle else {
        log(format!("打不开父进程 {pid}，当它已经没了，退出"));
        std::process::exit(0);
    };
    let raw = handle.0 as isize;
    std::thread::spawn(move || {
        let handle = windows::Win32::Foundation::HANDLE(raw as *mut _);
        let result = unsafe { WaitForSingleObject(handle, INFINITE) };
        if result == WAIT_OBJECT_0 || result != WAIT_TIMEOUT {
            log("父进程退出了，助手跟着退出");
            std::process::exit(0);
        }
    });
}

/// 60 秒没有请求就退出（正在处理请求时不算）
fn watch_idle() {
    *LAST_REQUEST.lock().unwrap_or_else(|e| e.into_inner()) = Some(Instant::now());
    std::thread::spawn(|| loop {
        std::thread::sleep(Duration::from_secs(5));
        let last = *LAST_REQUEST.lock().unwrap_or_else(|e| e.into_inner());
        if !BUSY.load(Ordering::SeqCst) && last.is_some_and(|t| t.elapsed() >= IDLE_EXIT) {
            log("60 秒没有请求，退出");
            std::process::exit(0);
        }
    });
}
