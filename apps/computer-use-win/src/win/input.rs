// 按坐标和键盘发真实输入：SendInput。
// 鼠标用虚拟桌面上的绝对坐标；type_text 用 KEYEVENTF_UNICODE 逐个 UTF-16 码元发（中文不经输入法）；
// press_key 的组合键先按下修饰键、再按主键，倒序松开。每个事件在 dwExtraInfo 里带固定标记 INJECTED_TAG，
// 低级钩子凭它把助手自己发的和其余输入（物理的，以及串流/远程软件转发进来的）分开。
use super::clipboard;
use crate::geometry::{absolute, Rect};
use crate::keys::{KeyCombo, VK_CONTROL};
use crate::text::{self, Keystroke};
use crate::wire::RpcResult;
use std::time::{Duration, Instant};
use windows::Win32::UI::Input::KeyboardAndMouse::*;
use windows::Win32::UI::WindowsAndMessaging::{GetSystemMetrics, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN};

/// 助手自己发的输入，在 dwExtraInfo 里带这个标记（ASCII "LITC"）。低级钩子凭它把自己发的和真实输入
/// （含 Moonlight、RDP 一类工具经 SendInput 转发的——那些带注入标记却没有这个值）分开。
pub const INJECTED_TAG: usize = 0x4C49_5443;
/// 一个滚轮刻度
const WHEEL_DELTA: i32 = 120;
/// 一批最多发多少个事件（点击、组合键这类一次发多个事件时分批，免得数组太大）
const BATCH: usize = 200;
/// 逐字发时每个键击之间等多久（毫秒）。只在退回逐字（粘贴不可用、或控制台类窗口）时用。
const TYPE_GAP_MS: u64 = 5;
/// 'V' 的虚拟键码（Ctrl+V 粘贴用）
const VK_V: u16 = 0x56;
/// 写完剪贴板、核对一致后，等一下再发 Ctrl+V（刚写完马上粘，目标 OpenClipboard 时剪贴板可能正被
/// 剪贴板历史、串流软件的剪贴板同步等占着而静默失败；也和前一个按键挨太近有关）
const PRE_PASTE_MS: u64 = 50;
/// 没有可确认的元素时，发完 Ctrl+V 固定等多久再恢复剪贴板（目标异步读剪贴板，等太短会把要粘的内容抢回去）
const PASTE_SETTLE_MS: u64 = 700;
/// 有可确认的元素时，每发一次 Ctrl+V 最多等多久确认粘贴已落下
const PASTE_CONFIRM_MAX_MS: u64 = 800;
/// 轮询元素文字变化的间隔
const PASTE_POLL_MS: u64 = 50;

/// 粘贴没确认落下时给模型看的英文提示（写进动作结果的 notes）
pub const PASTE_UNCONFIRMED_NOTE: &str = "typing may not have landed; check with get_app_state";

/// 虚拟桌面（所有显示器合起来）的矩形，物理像素
pub fn desktop() -> Rect {
    unsafe {
        let x = GetSystemMetrics(SM_XVIRTUALSCREEN);
        let y = GetSystemMetrics(SM_YVIRTUALSCREEN);
        let w = GetSystemMetrics(SM_CXVIRTUALSCREEN);
        let h = GetSystemMetrics(SM_CYVIRTUALSCREEN);
        Rect::new(x, y, x + w.max(1), y + h.max(1))
    }
}

fn key(vk: u16, scan: u16, flags: KEYBD_EVENT_FLAGS) -> INPUT {
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 { ki: KEYBDINPUT { wVk: VIRTUAL_KEY(vk), wScan: scan, dwFlags: flags, time: 0, dwExtraInfo: INJECTED_TAG } },
    }
}

fn mouse(dx: i32, dy: i32, data: i32, flags: MOUSE_EVENT_FLAGS) -> INPUT {
    INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 { mi: MOUSEINPUT { dx, dy, mouseData: data as u32, dwFlags: flags, time: 0, dwExtraInfo: INJECTED_TAG } },
    }
}

fn send(inputs: &[INPUT]) {
    for chunk in inputs.chunks(BATCH) {
        unsafe { SendInput(chunk, std::mem::size_of::<INPUT>() as i32) };
    }
}

/// 把光标移到屏幕坐标（绝对），作为一条输入
fn move_to(x: i32, y: i32) -> INPUT {
    let (ax, ay) = absolute(x, y, &desktop());
    mouse(ax, ay, 0, MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK)
}

fn button_flags(button: &str) -> RpcResult<(MOUSE_EVENT_FLAGS, MOUSE_EVENT_FLAGS)> {
    Ok(match button {
        "left" => (MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP),
        "right" => (MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP),
        "middle" => (MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP),
        _ => return Err(crate::fail!(Invalid, "button must be left, right or middle")),
    })
}

fn mods_down(modifiers: &[u16]) -> Vec<INPUT> {
    modifiers.iter().map(|&m| key(m, 0, KEYBD_EVENT_FLAGS(0))).collect()
}

fn mods_up(modifiers: &[u16]) -> Vec<INPUT> {
    modifiers.iter().rev().map(|&m| key(m, 0, KEYEVENTF_KEYUP)).collect()
}

/// 在屏幕坐标点击：移过去，按住修饰键，按 count 次键，松开修饰键
pub fn click(x: i32, y: i32, button: &str, count: u32, modifiers: &[u16]) -> RpcResult<()> {
    let (down, up) = button_flags(button)?;
    let mut inputs = vec![move_to(x, y)];
    inputs.extend(mods_down(modifiers));
    for _ in 0..count.clamp(1, 3) {
        inputs.push(mouse(0, 0, 0, down));
        inputs.push(mouse(0, 0, 0, up));
    }
    inputs.extend(mods_up(modifiers));
    send(&inputs);
    Ok(())
}

/// 在屏幕坐标处发滚轮
pub fn wheel(x: i32, y: i32, direction: &str, amount: i32) -> RpcResult<()> {
    let notches = amount.clamp(1, 50);
    let (flag, delta): (MOUSE_EVENT_FLAGS, i32) = match direction {
        "up" => (MOUSEEVENTF_WHEEL, WHEEL_DELTA),
        "down" => (MOUSEEVENTF_WHEEL, -WHEEL_DELTA),
        "right" => (MOUSEEVENTF_HWHEEL, WHEEL_DELTA),
        "left" => (MOUSEEVENTF_HWHEEL, -WHEEL_DELTA),
        _ => return Err(crate::fail!(Invalid, "direction must be up, down, left or right")),
    };
    let mut inputs = vec![move_to(x, y)];
    for _ in 0..notches {
        inputs.push(mouse(0, 0, delta, flag));
    }
    send(&inputs);
    Ok(())
}

/// 从一点拖到另一点：按下、分几步移动、松开
pub fn drag(from: (i32, i32), to: (i32, i32)) -> RpcResult<()> {
    let mut inputs = vec![move_to(from.0, from.1), mouse(0, 0, 0, MOUSEEVENTF_LEFTDOWN)];
    let steps = 10;
    for i in 1..=steps {
        let x = from.0 + (to.0 - from.0) * i / steps;
        let y = from.1 + (to.1 - from.1) * i / steps;
        inputs.push(move_to(x, y));
    }
    inputs.push(mouse(0, 0, 0, MOUSEEVENTF_LEFTUP));
    send(&inputs);
    Ok(())
}

/// 粘贴的结果
enum Paste {
    /// 确认粘贴已落下（元素文字变了），或没有可确认的元素、固定等后假定已落下
    Ok,
    /// 有可确认的元素，重发后仍没确认到变化——很可能没粘进去
    Unconfirmed,
    /// 剪贴板不可用（打不开、写回核对不一致）——调用方退回逐字
    ClipboardUnavailable,
}

/// 输入文字：普通窗口走剪贴板 + Ctrl+V（记事本这类 TSF 控件逐字发会吞字）；控制台类窗口的粘贴快捷键
/// 不统一（旧控制台要右键、各家终端不一），所以照旧逐字发。剪贴板不可用时退回逐字。
/// `confirmed`：给了就用它判粘贴有没有落下（轮询目标元素文字变化），用来决定何时恢复剪贴板、要不要重发；
/// 没给（焦点元素既没有值也没有文字）就固定等。回一个可选的 notes 提示：粘贴没确认落下时提醒模型去核对。
pub fn enter_text(value: &str, window_class: &str, confirmed: Option<&dyn Fn() -> bool>) -> Option<&'static str> {
    if value.is_empty() {
        return None;
    }
    if is_console_class(window_class) {
        type_per_char(value);
        return None;
    }
    match paste_text(value, confirmed) {
        Paste::Ok => None,
        Paste::Unconfirmed => Some(PASTE_UNCONFIRMED_NOTE),
        Paste::ClipboardUnavailable => {
            type_per_char(value);
            None
        }
    }
}

/// 控制台/终端类窗口（粘贴快捷键不统一，走逐字更稳）
fn is_console_class(class: &str) -> bool {
    matches!(
        class,
        "ConsoleWindowClass"              // 传统 conhost
            | "CASCADIA_HOSTING_WINDOW_CLASS" // Windows Terminal
            | "PseudoConsoleWindow"
            | "mintty"                        // Git Bash
    )
}

/// 剪贴板 + Ctrl+V：存原内容 → 写入 → 读回核对 → 等 50ms → 粘贴 → 确认落下 → 恢复原内容。
/// 注意：粘贴期间剪贴板被临时占用（放的是要打的文字），落下后才会恢复成用户原来的内容。
/// 有确认回调时：发一次等最多 800ms，没变化就再发一次（剪贴板里还是要打的文字）再等；两次都没变化回
/// Unconfirmed。没有确认回调（焦点元素既没有值也没有文字）就固定等 PASTE_SETTLE_MS，当作已落下。
fn paste_text(value: &str, confirmed: Option<&dyn Fn() -> bool>) -> Paste {
    let saved = clipboard::get_text();
    if !clipboard::set_text(value) {
        return Paste::ClipboardUnavailable;
    }
    if clipboard::get_text().as_deref() != Some(value) {
        if let Some(prev) = &saved {
            clipboard::set_text(prev);
        }
        return Paste::ClipboardUnavailable;
    }
    // 刚写完剪贴板稍等再粘，躲开剪贴板被别的进程短暂占用导致 Ctrl+V 静默失败
    std::thread::sleep(Duration::from_millis(PRE_PASTE_MS));
    send_paste();
    let result = match confirmed {
        None => {
            std::thread::sleep(Duration::from_millis(PASTE_SETTLE_MS));
            Paste::Ok
        }
        Some(check) => {
            if wait_for_change(check) {
                Paste::Ok
            } else {
                // 没落下，剪贴板里还是要打的文字，再发一次
                send_paste();
                if wait_for_change(check) {
                    Paste::Ok
                } else {
                    Paste::Unconfirmed
                }
            }
        }
    };
    if let Some(prev) = saved {
        clipboard::set_text(&prev);
    }
    result
}

/// 发一次 Ctrl+V（带 INJECTED_TAG）
fn send_paste() {
    press_key(&KeyCombo { modifiers: vec![VK_CONTROL], key: VK_V, extended: false }, 1);
}

/// 轮询确认回调，最多等 PASTE_CONFIRM_MAX_MS；变化了回 true，超时回 false
fn wait_for_change(check: &dyn Fn() -> bool) -> bool {
    let deadline = Instant::now() + Duration::from_millis(PASTE_CONFIRM_MAX_MS);
    loop {
        std::thread::sleep(Duration::from_millis(PASTE_POLL_MS));
        if check() {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
    }
}

/// 一次一个键击逐字发：每个字符（或回车、Tab）单独一次 SendInput、中间留间隔。代理对的两个码元同一次发。
fn type_per_char(value: &str) {
    for stroke in text::keystrokes(value) {
        let mut inputs = vec![];
        match stroke {
            Keystroke::Char(c) => {
                let mut buf = [0u16; 2];
                for unit in c.encode_utf16(&mut buf) {
                    inputs.push(key(0, *unit, KEYEVENTF_UNICODE));
                    inputs.push(key(0, *unit, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP));
                }
            }
            Keystroke::Key(vk) => {
                inputs.push(key(vk, 0, KEYBD_EVENT_FLAGS(0)));
                inputs.push(key(vk, 0, KEYEVENTF_KEYUP));
            }
        }
        send(&inputs);
        std::thread::sleep(Duration::from_millis(TYPE_GAP_MS));
    }
}

/// 发一个组合键 repeat 次
pub fn press_key(combo: &KeyCombo, repeat: u32) {
    let extended = if combo.extended { KEYEVENTF_EXTENDEDKEY } else { KEYBD_EVENT_FLAGS(0) };
    let mut inputs = mods_down(&combo.modifiers);
    for _ in 0..repeat.clamp(1, 50) {
        inputs.push(key(combo.key, 0, extended));
        inputs.push(key(combo.key, 0, extended | KEYEVENTF_KEYUP));
    }
    inputs.extend(mods_up(&combo.modifiers));
    send(&inputs);
}
