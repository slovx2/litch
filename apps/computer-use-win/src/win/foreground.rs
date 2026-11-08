// 切前台与落点核对。
// 每个输入动作前确认目标窗口在前台：不在就 SetForegroundWindow，不行再借 AttachThreadInput 挂到当前前台线程上再试，
// 仍然不行就回 foreground 错误，让模型请用户点一下那个窗口。坐标点击前用 WindowFromPoint 核对落点，避免点到盖在上面的窗口。
use super::apps;
use crate::fail;
use crate::wire::RpcResult;
use std::time::Duration;
use windows::Win32::Foundation::{HWND, POINT};
use windows::Win32::System::Threading::{AttachThreadInput, GetCurrentThreadId};
use windows::Win32::UI::WindowsAndMessaging::{
    BringWindowToTop, GetForegroundWindow, GetWindowThreadProcessId, IsIconic, SetForegroundWindow, ShowWindow, WindowFromPoint, SW_RESTORE,
};

#[derive(Clone)]
struct ActiveInput { target: isize, revision: u64, session: String, app_id: String }
thread_local! {
    static ACTIVE: std::cell::RefCell<Option<ActiveInput>> = const { std::cell::RefCell::new(None) };
}

pub struct Excursion { previous: HWND, target: HWND, revision: u64, sequence: u64, interactions: u64, cursor: POINT }
impl Excursion {
    pub fn begin(target: HWND, session: &str, app_id: &str) -> RpcResult<Self> {
        crate::action::check()?;
        let started = std::time::Instant::now();
        while super::hooks::held() || super::uia::composing() {
            if super::activity::is_stopped(session, app_id) { return Err(fail!(Stopped, "the user stopped this turn")); }
            if started.elapsed() >= Duration::from_secs(8) {
                return Err(fail!(UserActive, "a button/key is held or IME composition is active; no input sent. Retry this step after release; the session is not stopped"));
            }
            crate::action::sleep(Duration::from_millis(25))?;
        }
        let revision = super::hooks::revision(target.0 as isize);
        let mut cursor = POINT::default();
        unsafe { let _ = windows::Win32::UI::WindowsAndMessaging::GetCursorPos(&mut cursor); }
        let scope = Self { previous: unsafe { GetForegroundWindow() }, target, revision, sequence: super::hooks::sequence(), interactions: super::hooks::interactions(), cursor };
        ACTIVE.with(|cell| *cell.borrow_mut() = Some(ActiveInput { target: target.0 as isize, revision, session: session.into(), app_id: app_id.into() }));
        ensure(target)?;
        check_input()?;
        Ok(scope)
    }
}
impl Drop for Excursion {
    fn drop(&mut self) {
        ACTIVE.with(|cell| *cell.borrow_mut() = None);
        // 只在目标仍是前台且没有目标输入碰撞时恢复；用户已换窗口就尊重其选择。
        if self.previous != self.target && !self.previous.is_invalid() && same_foreground_process(self.target)
            && super::hooks::interactions() == self.interactions
            && super::hooks::revision(self.target.0 as isize) == self.revision {
            let _ = ensure(self.previous);
        }
        if super::hooks::sequence() == self.sequence {
            unsafe { let _ = windows::Win32::UI::WindowsAndMessaging::SetCursorPos(self.cursor.x, self.cursor.y); }
        }
    }
}

pub fn check_input() -> RpcResult<()> {
    check(false)
}

/// 单次点击/快捷键可能打开同进程的新窗口；完成检查不把预期的窗口切换当作用户输入。
pub fn check_completion() -> RpcResult<()> {
    check(true)
}

fn same_foreground_process(target: HWND) -> bool {
    let pid = super::system::window_pid(target);
    pid != 0 && super::system::window_pid(unsafe { GetForegroundWindow() }) == pid
}

fn check(completed: bool) -> RpcResult<()> {
    crate::action::check()?;
    ACTIVE.with(|cell| {
        let Some(active) = cell.borrow().clone() else { return Ok(()) };
        if super::activity::is_stopped(&active.session, &active.app_id) { return Err(fail!(Stopped, "the user stopped this turn")); }
        let target = apps::hwnd(active.target);
        let destination_ok = if completed { same_foreground_process(target) } else { is_foreground(target) };
        if super::hooks::revision(active.target) != active.revision || !destination_ok
            || super::hooks::pointer_held() || super::uia::composing() {
            return Err(fail!(UserActive, "input overlapped or the destination changed; only this action stopped and may be partially completed. Read get_app_state and retry the unfinished step; the session is not stopped"));
        }
        Ok(())
    })
}

/// 把目标窗口切到前台。切不到回 foreground 错误
pub fn ensure(target: HWND) -> RpcResult<()> {
    unsafe {
        if IsIconic(target).as_bool() {
            let _ = ShowWindow(target, SW_RESTORE);
        }
        if is_foreground(target) {
            return Ok(());
        }
        // SetForegroundWindow、AttachThreadInput 都是异步生效：调完立刻读 GetForegroundWindow 可能还是旧值，
        // 所以每一步之后都轮询等前台真的切过来，等到就算成功，别误判成切不动。
        let _ = SetForegroundWindow(target);
        if wait_foreground(target) {
            return Ok(());
        }
        // 常规办法不行：挂到当前前台线程上，绕过前台锁
        let fg = GetForegroundWindow();
        let ours = GetCurrentThreadId();
        let other = GetWindowThreadProcessId(fg, None);
        if other != 0 && other != ours {
            let _ = AttachThreadInput(ours, other, true);
            let _ = BringWindowToTop(target);
            let _ = SetForegroundWindow(target);
            let got = wait_foreground(target);
            let _ = AttachThreadInput(ours, other, false);
            if got {
                return Ok(());
            }
        }
    }
    Err(fail!(Foreground, "could not bring the window to the front; ask the user to click the window, then try again"))
}

fn is_foreground(target: HWND) -> bool {
    unsafe { GetForegroundWindow() == target }
}

/// 前台切换是异步的：最多等约 400ms（每 20ms 看一次），其间前台变成目标就算成功
fn wait_foreground(target: HWND) -> bool {
    for _ in 0..20 {
        if is_foreground(target) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    is_foreground(target)
}

/// 坐标落点核对：这个屏幕点下面的根窗口要是目标窗口，不然拒绝（盖在上面的是别的窗口）
pub fn hit_ok(target: HWND, x: i32, y: i32) -> RpcResult<()> {
    let under = unsafe { WindowFromPoint(POINT { x, y }) };
    if under.is_invalid() {
        return Err(fail!(Invalid, "the point ({x}, {y}) is not over any window"));
    }
    if apps::root(under) != apps::root(target) {
        return Err(fail!(Invalid, "the point lands on a different window covering the target; read the window state again and retry"));
    }
    Ok(())
}
