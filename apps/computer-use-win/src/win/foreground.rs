// 切前台与落点核对（09 号 3.8 节、决 260）。
// 每个输入动作前确认目标窗口在前台：不在就 SetForegroundWindow，不行再借 AttachThreadInput 挂到当前前台线程上再试，
// 仍然不行就回 foreground 错误，让模型请用户点一下那个窗口。坐标点击前用 WindowFromPoint 核对落点，避免点到盖在上面的窗口。
use super::apps;
use crate::fail;
use crate::wire::RpcResult;
use windows::Win32::Foundation::{HWND, POINT};
use windows::Win32::System::Threading::{AttachThreadInput, GetCurrentThreadId};
use windows::Win32::UI::WindowsAndMessaging::{
    BringWindowToTop, GetForegroundWindow, GetWindowThreadProcessId, IsIconic, SetForegroundWindow, ShowWindow, WindowFromPoint, SW_RESTORE,
};

/// 把目标窗口切到前台。切不到回 foreground 错误
pub fn ensure(target: HWND) -> RpcResult<()> {
    unsafe {
        if IsIconic(target).as_bool() {
            let _ = ShowWindow(target, SW_RESTORE);
        }
        if GetForegroundWindow() == target {
            return Ok(());
        }
        let _ = SetForegroundWindow(target);
        if GetForegroundWindow() == target {
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
            let _ = AttachThreadInput(ours, other, false);
        }
        if GetForegroundWindow() == target {
            return Ok(());
        }
    }
    Err(fail!(Foreground, "could not bring the window to the front; ask the user to click the window, then try again"))
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
