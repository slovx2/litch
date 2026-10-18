// 低级键盘和鼠标钩子（09 号 3.9 节）：专门一条线程装 WH_KEYBOARD_LL、WH_MOUSE_LL 并跑消息循环。
// - 不带注入标记的 Esc：交给 activity::stop_all（本回合停掉正在操作的应用，通知主进程）；
// - 不带注入标记的鼠标和键盘输入：记下时间和位置，动作前查“用户是不是正在动这个窗口”。
// 回调里只做记录，不做任何耗时的事，否则系统会在超时后摘掉钩子。Esc 的处理经线程消息转到循环里做。
use super::system::log;
use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{mpsc, Mutex};
use std::time::{Duration, Instant};
use windows::Win32::Foundation::{LPARAM, LRESULT, POINT, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::Threading::GetCurrentThreadId;
use windows::Win32::UI::Input::KeyboardAndMouse::VK_ESCAPE;
use windows::Win32::UI::WindowsAndMessaging::*;

const WM_ESCAPE: u32 = WM_APP + 1;
/// 鼠标移动记录的最小间隔
const MOVE_EVERY: Duration = Duration::from_millis(30);

#[derive(Clone, Copy)]
enum Physical {
    Mouse { x: i32, y: i32, at: Instant },
    Key { foreground: isize, at: Instant },
}

static EVENTS: Mutex<VecDeque<Physical>> = Mutex::new(VecDeque::new());
static LAST_MOVE: Mutex<Option<Instant>> = Mutex::new(None);
static THREAD: AtomicU32 = AtomicU32::new(0);
static INSTALLED: AtomicBool = AtomicBool::new(false);
static STARTED: AtomicBool = AtomicBool::new(false);

fn record(event: Physical) {
    if let Ok(mut events) = EVENTS.try_lock() {
        if events.len() >= 256 {
            events.pop_front();
        }
        events.push_back(event);
    }
}

unsafe extern "system" fn keyboard(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code == HC_ACTION as i32 {
        let info = &*(lparam.0 as *const KBDLLHOOKSTRUCT);
        if info.flags.0 & LLKHF_INJECTED.0 == 0 {
            record(Physical::Key { foreground: GetForegroundWindow().0 as isize, at: Instant::now() });
            let down = wparam.0 as u32 == WM_KEYDOWN || wparam.0 as u32 == WM_SYSKEYDOWN;
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
        // LLMHF_INJECTED = 1
        if info.flags & 1 == 0 {
            let now = Instant::now();
            let is_move = wparam.0 as u32 == WM_MOUSEMOVE;
            let keep = !is_move
                || LAST_MOVE.try_lock().map_or(false, |mut last| {
                    let due = last.is_none_or(|t| now.duration_since(t) >= MOVE_EVERY);
                    if due {
                        *last = Some(now);
                    }
                    due
                });
            if keep {
                record(Physical::Mouse { x: info.pt.x, y: info.pt.y, at: now });
            }
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

pub fn installed() -> bool {
    INSTALLED.load(Ordering::SeqCst)
}

/// 用户最近一次在这个窗口上动（鼠标落在 rect 里，或这个窗口在前台时按键）的时间
pub fn last_user_input(hwnd: isize, rect: &crate::geometry::Rect) -> Option<Instant> {
    let events = EVENTS.lock().unwrap_or_else(|e| e.into_inner());
    events.iter().rev().find_map(|event| match *event {
        Physical::Mouse { x, y, at } if rect.contains(x, y) => Some(at),
        Physical::Key { foreground, at } if foreground == hwnd => Some(at),
        _ => None,
    })
}

/// 光标现在的位置（物理像素）
pub fn cursor() -> Option<(i32, i32)> {
    let mut point = POINT::default();
    unsafe { GetCursorPos(&mut point).ok()? };
    Some((point.x, point.y))
}
