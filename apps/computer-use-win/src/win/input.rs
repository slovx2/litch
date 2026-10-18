// 按坐标和键盘发真实输入（09 号 3.8 节）：SendInput。
// 鼠标用虚拟桌面上的绝对坐标；type_text 用 KEYEVENTF_UNICODE 逐个 UTF-16 码元发（中文不经输入法）；
// press_key 的组合键先按下修饰键、再按主键，倒序松开。SendInput 自己会给事件打上“注入”标记，低级钩子据此和物理输入区分。
use crate::geometry::{absolute, Rect};
use crate::keys::KeyCombo;
use crate::text::{self, TypeStep};
use crate::wire::RpcResult;
use windows::Win32::UI::Input::KeyboardAndMouse::*;
use windows::Win32::UI::WindowsAndMessaging::{GetSystemMetrics, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN};

/// 一个滚轮刻度
const WHEEL_DELTA: i32 = 120;
/// 一批最多发多少个事件（长文字分批，免得一次的数组太大）
const BATCH: usize = 200;

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
        Anonymous: INPUT_0 { ki: KEYBDINPUT { wVk: VIRTUAL_KEY(vk), wScan: scan, dwFlags: flags, time: 0, dwExtraInfo: 0 } },
    }
}

fn mouse(dx: i32, dy: i32, data: i32, flags: MOUSE_EVENT_FLAGS) -> INPUT {
    INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 { mi: MOUSEINPUT { dx, dy, mouseData: data as u32, dwFlags: flags, time: 0, dwExtraInfo: 0 } },
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

/// 逐个 UTF-16 码元打字（换行、制表符按真实键发）
pub fn type_text(value: &str) {
    let mut inputs = vec![];
    for step in text::plan(value) {
        match step {
            TypeStep::Unit(unit) => {
                inputs.push(key(0, unit, KEYEVENTF_UNICODE));
                inputs.push(key(0, unit, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP));
            }
            TypeStep::Key(vk) => {
                inputs.push(key(vk, 0, KEYBD_EVENT_FLAGS(0)));
                inputs.push(key(vk, 0, KEYEVENTF_KEYUP));
            }
        }
    }
    send(&inputs);
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
