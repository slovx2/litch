// 低级键盘和鼠标钩子：专门一条线程装 WH_KEYBOARD_LL、WH_MOUSE_LL 并跑消息循环。
// 区分事件靠 dwExtraInfo 里的标记（input::INJECTED_TAG），不看系统的注入标志：带标记的是助手自己发的，
// 其余（物理输入，以及 Moonlight、RDP 一类工具转发进来的——它们带系统注入标志但没有我们的标记）都算用户输入。
// - 用户发的 Esc：交给 activity::stop_all（本回合停掉正在操作的应用，通知主进程）；
// - 用户按下鼠标或键盘：按实际目标窗口记版本，只中止发生碰撞的当前前台步骤。
// 回调里只做记录，不做任何耗时的事，否则系统会在超时后摘掉钩子。Esc 的处理经线程消息转到循环里做。
use super::system::log;
use crate::input_conflict::{InputConflict, Kind};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{mpsc, Mutex};
use std::time::Duration;
use windows::Win32::Foundation::{LPARAM, LRESULT, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::Threading::GetCurrentThreadId;
use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_ESCAPE};
use windows::Win32::UI::WindowsAndMessaging::*;

const WM_ESCAPE: u32 = WM_APP + 1;
static INPUT: Mutex<InputConflict> = Mutex::new(InputConflict::new());

static THREAD: AtomicU32 = AtomicU32::new(0);
static INSTALLED: AtomicBool = AtomicBool::new(false);
static STARTED: AtomicBool = AtomicBool::new(false);

fn record(kind: Kind, hwnd: isize, code: u32) {
    INPUT.lock().unwrap_or_else(|e| e.into_inner()).note(kind, hwnd, code);
}

unsafe extern "system" fn keyboard(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code == HC_ACTION as i32 {
        let info = &*(lparam.0 as *const KBDLLHOOKSTRUCT);
        // 只放过助手自己发的（带我们的标记）；物理按键和串流/远程软件转发进来的都算用户输入
        if info.dwExtraInfo != super::input::INJECTED_TAG {
            let down = wparam.0 as u32 == WM_KEYDOWN || wparam.0 as u32 == WM_SYSKEYDOWN;
            record(if down { Kind::Down } else { Kind::Up }, GetForegroundWindow().0 as isize, info.vkCode);
            if down && info.vkCode == VK_ESCAPE.0 as u32 {
                let _ = PostThreadMessageW(THREAD.load(Ordering::Relaxed), WM_ESCAPE, WPARAM(0), LPARAM(0));
            }
        }
    }
    CallNextHookEx(None, code, wparam, lparam)
}

unsafe extern "system" fn mouse(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code == HC_ACTION as i32 {
        let info = &*(lparam.0 as *const MSLLHOOKSTRUCT);
        // 同上：只有带我们标记的才是助手自己发的，其余（物理、串流/远程转发）都算用户在动
        if info.dwExtraInfo != super::input::INJECTED_TAG {
            let (kind, button) = match wparam.0 as u32 {
                WM_LBUTTONDOWN => (Kind::Down, 256), WM_LBUTTONUP => (Kind::Up, 256),
                WM_RBUTTONDOWN => (Kind::Down, 257), WM_RBUTTONUP => (Kind::Up, 257),
                WM_MBUTTONDOWN => (Kind::Down, 258), WM_MBUTTONUP => (Kind::Up, 258),
                WM_XBUTTONDOWN => (Kind::Down, 259 + (info.mouseData >> 16)),
                WM_XBUTTONUP => (Kind::Up, 259 + (info.mouseData >> 16)),
                _ => (Kind::Observe, 0),
            };
            // 记录事件发生时实际命中的根窗口，不能用矩形重叠推断后台窗口被操作。
            let hwnd = super::apps::root(WindowFromPoint(info.pt));
            record(kind, hwnd.0 as isize, button);
        }
    }
    CallNextHookEx(None, code, wparam, lparam)
}

/// 起钩子线程（只起一次）。回钩子装没装上
pub fn start() -> bool {
    if STARTED.swap(true, Ordering::SeqCst) {
        return INSTALLED.load(Ordering::SeqCst);
    }
    let (tx, rx) = mpsc::channel::<bool>();
    std::thread::Builder::new()
        .name("hooks".into())
        .spawn(move || unsafe {
            THREAD.store(GetCurrentThreadId(), Ordering::SeqCst);
            // 补上钩子启动前已按住的输入，随后由正常 up 事件清除。
            for code in 1..=254 {
                if (16..=18).contains(&code) { continue; } // 通用 Shift/Ctrl/Alt 没有对应 up，使用左右键码。
                if GetAsyncKeyState(code) < 0 {
                    let key = match code { 1 => 256, 2 => 257, 4 => 258, 5 => 260, 6 => 261, _ => code as u32 };
                    record(Kind::Down, 0, key);
                }
            }
            let module = GetModuleHandleW(None).ok();
            let kb = SetWindowsHookExW(WH_KEYBOARD_LL, Some(keyboard), module.map(Into::into), 0);
            let ms = SetWindowsHookExW(WH_MOUSE_LL, Some(mouse), module.map(Into::into), 0);
            let ok = kb.is_ok() && ms.is_ok();
            if !ok {
                log(format!("装钩子失败：键盘 {:?}，鼠标 {:?}", kb.as_ref().err(), ms.as_ref().err()));
            }
            INSTALLED.store(ok, Ordering::SeqCst);
            let _ = tx.send(ok);
            let mut msg = MSG::default();
            while GetMessageW(&mut msg, None, 0, 0).as_bool() {
                if msg.message == WM_ESCAPE {
                    super::activity::stop_all();
                    continue;
                }
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
        })
        .ok();
    rx.recv_timeout(Duration::from_secs(3)).unwrap_or(false)
}

/// 查看、移动和滚动不改变目标输入版本；版本只在当前前台动作的作用域比较。
pub fn revision(hwnd: isize) -> u64 {
    INPUT.lock().unwrap_or_else(|e| e.into_inner()).revision(hwnd)
}
pub fn held() -> bool {
    INPUT.lock().unwrap_or_else(|e| e.into_inner()).blocked(false, false)
}
pub fn sequence() -> u64 {
    INPUT.lock().unwrap_or_else(|e| e.into_inner()).sequence
}
pub fn pointer_held() -> bool {
    INPUT.lock().unwrap_or_else(|e| e.into_inner()).pointer_held()
}
pub fn interactions() -> u64 {
    INPUT.lock().unwrap_or_else(|e| e.into_inner()).interactions
}
