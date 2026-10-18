// 组合键的解析：“ctrl+shift+t”“Return”“alt+F4”→ Windows 虚拟键码加修饰键。
// 键名沿用 macOS 助手的写法（名字不分大小写，下划线、连字符忽略），差别：
//   - cmd/command 在 Windows 上就是 Ctrl（模型常按 Mac 习惯写 cmd+c）；
//   - Windows 键（win、super、meta）一律拒绝，免得模型打开开始菜单、Win+R 一类；
//   - Delete 是向前删除（Windows 键盘上的 Del），退格写 BackSpace。
use crate::fail;
use crate::wire::RpcResult;

pub const VK_SHIFT: u16 = 0x10;
pub const VK_CONTROL: u16 = 0x11;
pub const VK_MENU: u16 = 0x12;
pub const VK_RETURN: u16 = 0x0D;
pub const VK_TAB: u16 = 0x09;
pub const VK_ESCAPE: u16 = 0x1B;

/// 一个组合键：先按下修饰键，再按主键，倒序松开
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeyCombo {
    pub modifiers: Vec<u16>,
    pub key: u16,
    /// 主键要带 KEYEVENTF_EXTENDEDKEY（方向键、Home、Del 等）
    pub extended: bool,
}

fn normalize(name: &str) -> String {
    name.trim().to_lowercase().replace(['_', '-'], "")
}

fn modifier(name: &str) -> RpcResult<Option<u16>> {
    Ok(match name {
        "ctrl" | "control" | "controll" | "controlr" | "ctrll" | "ctrlr" | "cmd" | "command" => Some(VK_CONTROL),
        "alt" | "altl" | "altr" | "option" | "opt" | "menu" => Some(VK_MENU),
        "shift" | "shiftl" | "shiftr" => Some(VK_SHIFT),
        "win" | "windows" | "super" | "superl" | "superr" | "meta" | "metal" | "metar" | "lwin" | "rwin" => {
            return Err(fail!(Invalid, "The Windows key is not allowed. Use the app's own menus or shortcuts instead."));
        }
        "fn" => return Err(fail!(Invalid, "fn is not a key on Windows; press the key itself (for example F5 or Delete).")),
        _ => None,
    })
}

/// 有名字的键：(键码, 是否扩展键)
fn named(name: &str) -> Option<(u16, bool)> {
    let pair = match name {
        "return" | "enter" => (VK_RETURN, false),
        "kpenter" => (VK_RETURN, true),
        "tab" => (VK_TAB, false),
        "space" => (0x20, false),
        "escape" | "esc" => (VK_ESCAPE, false),
        "backspace" => (0x08, false),
        "delete" | "del" | "forwarddelete" => (0x2E, true),
        "insert" | "ins" | "help" => (0x2D, true),
        "home" => (0x24, true),
        "end" => (0x23, true),
        "pageup" | "prior" => (0x21, true),
        "pagedown" | "next" => (0x22, true),
        "left" | "arrowleft" => (0x25, true),
        "up" | "arrowup" => (0x26, true),
        "right" | "arrowright" => (0x27, true),
        "down" | "arrowdown" => (0x28, true),
        "capslock" => (0x14, false),
        "numlock" => (0x90, true),
        "scrolllock" => (0x91, false),
        "pause" => (0x13, false),
        "printscreen" | "print" => (0x2C, true),
        "apps" | "contextmenu" => (0x5D, true),
        "minus" => (0xBD, false),
        "equal" | "plus" => (0xBB, false),
        "comma" => (0xBC, false),
        "period" => (0xBE, false),
        "slash" => (0xBF, false),
        "semicolon" => (0xBA, false),
        "quote" | "apostrophe" => (0xDE, false),
        "bracketleft" => (0xDB, false),
        "bracketright" => (0xDD, false),
        "backslash" => (0xDC, false),
        "grave" => (0xC0, false),
        "kpadd" => (0x6B, false),
        "kpsubtract" => (0x6D, false),
        "kpmultiply" => (0x6A, false),
        "kpdivide" => (0x6F, true),
        "kpdecimal" => (0x6E, false),
        _ => {
            if let Some(n) = name.strip_prefix('f').and_then(|d| d.parse::<u16>().ok()) {
                if (1..=24).contains(&n) {
                    return Some((0x70 + n - 1, false));
                }
            }
            if let Some(n) = name.strip_prefix("kp").and_then(|d| d.parse::<u16>().ok()) {
                if n <= 9 {
                    return Some((0x60 + n, false));
                }
            }
            return None;
        }
    };
    Some(pair)
}

/// 单个字符对应的键（美式键盘的位置）
fn character(c: char) -> Option<u16> {
    let c = c.to_ascii_lowercase();
    match c {
        'a'..='z' => Some(c as u16 - 'a' as u16 + 0x41),
        '0'..='9' => Some(c as u16 - '0' as u16 + 0x30),
        '-' => Some(0xBD),
        '=' => Some(0xBB),
        '[' => Some(0xDB),
        ']' => Some(0xDD),
        '\\' => Some(0xDC),
        ';' => Some(0xBA),
        '\'' => Some(0xDE),
        ',' => Some(0xBC),
        '.' => Some(0xBE),
        '/' => Some(0xBF),
        '`' => Some(0xC0),
        ' ' => Some(0x20),
        _ => None,
    }
}

/// 只把一组修饰键名解析成虚拟键码（click、scroll 的 modifiers 用）：cmd 映射成 ctrl，Windows 键拒绝
pub fn modifiers(names: &[String]) -> RpcResult<Vec<u16>> {
    let mut out: Vec<u16> = vec![];
    for raw in names {
        match modifier(&normalize(raw))? {
            Some(vk) => {
                if !out.contains(&vk) {
                    out.push(vk);
                }
            }
            None => return Err(fail!(Invalid, "unknown modifier \"{raw}\"; use ctrl, alt or shift")),
        }
    }
    Ok(out)
}

/// 解析一个组合键；`extra` 是工具参数里另给的修饰键
pub fn parse(text: &str, extra: &[String]) -> RpcResult<KeyCombo> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Err(fail!(Invalid, "key is empty"));
    }
    let mut parts: Vec<String> = trimmed.split('+').map(str::to_string).collect();
    // “ctrl++”：最后那个加号本身就是键
    if trimmed.ends_with("++") {
        parts.truncate(parts.len() - 2);
        parts.push("+".into());
    }
    let key_name = parts.pop().unwrap_or_default();
    if key_name.is_empty() {
        return Err(fail!(Invalid, "missing key after modifiers in \"{text}\""));
    }
    let mut modifiers: Vec<u16> = vec![];
    for raw in parts.iter().chain(extra.iter()) {
        match modifier(&normalize(raw))? {
            Some(vk) => {
                if !modifiers.contains(&vk) {
                    modifiers.push(vk);
                }
            }
            None => {
                return Err(fail!(Invalid, "unknown modifier \"{raw}\" in \"{text}\"; use ctrl, alt or shift"));
            }
        }
    }
    let name = normalize(&key_name);
    // 只按一个修饰键：发它自己的键码
    if let Some(vk) = modifier(&name)? {
        modifiers.retain(|m| *m != vk);
        return Ok(KeyCombo { modifiers, key: vk, extended: false });
    }
    if key_name == "+" {
        if !modifiers.contains(&VK_SHIFT) {
            modifiers.push(VK_SHIFT);
        }
        return Ok(KeyCombo { modifiers, key: 0xBB, extended: false });
    }
    if let Some((key, extended)) = named(&name) {
        return Ok(KeyCombo { modifiers, key, extended });
    }
    let mut chars = key_name.chars();
    if let (Some(c), None) = (chars.next(), chars.next()) {
        if let Some(key) = character(c) {
            return Ok(KeyCombo { modifiers, key, extended: false });
        }
    }
    Err(fail!(
        Invalid,
        "unknown key \"{key_name}\"; use a single character or a name like Return, Tab, Escape, BackSpace, Delete, Left, Page_Up, F5. To type text use type_text"
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wire::Kind;

    fn combo(text: &str) -> KeyCombo {
        parse(text, &[]).unwrap()
    }

    #[test]
    fn plain_keys() {
        assert_eq!(combo("Return"), KeyCombo { modifiers: vec![], key: VK_RETURN, extended: false });
        assert_eq!(combo("page_up").key, 0x21);
        assert!(combo("Page-Down").extended);
        assert_eq!(combo("F5").key, 0x74);
        assert_eq!(combo("f24").key, 0x87);
        assert_eq!(combo("a").key, 0x41);
        assert_eq!(combo("Z").key, 0x5A);
        assert_eq!(combo("7").key, 0x37);
        assert_eq!(combo("Delete"), KeyCombo { modifiers: vec![], key: 0x2E, extended: true });
        assert_eq!(combo("BackSpace").key, 0x08);
        assert_eq!(combo("KP_5").key, 0x65);
    }

    #[test]
    fn combos() {
        assert_eq!(combo("ctrl+s"), KeyCombo { modifiers: vec![VK_CONTROL], key: 0x53, extended: false });
        assert_eq!(combo("cmd+shift+t").modifiers, vec![VK_CONTROL, VK_SHIFT]);
        assert_eq!(combo("alt+F4"), KeyCombo { modifiers: vec![VK_MENU], key: 0x73, extended: false });
        assert_eq!(combo("ctrl++"), KeyCombo { modifiers: vec![VK_CONTROL, VK_SHIFT], key: 0xBB, extended: false });
        assert_eq!(combo("Control_L+Home").modifiers, vec![VK_CONTROL]);
        let with_extra = parse("s", &["ctrl".into(), "shift".into(), "ctrl".into()]).unwrap();
        assert_eq!(with_extra.modifiers, vec![VK_CONTROL, VK_SHIFT]);
    }

    #[test]
    fn modifier_list() {
        assert_eq!(modifiers(&["ctrl".into(), "shift".into(), "cmd".into()]).unwrap(), vec![VK_CONTROL, VK_SHIFT]);
        assert_eq!(modifiers(&[]).unwrap(), Vec::<u16>::new());
        assert_eq!(modifiers(&["win".into()]).unwrap_err().kind, Kind::Invalid);
        assert_eq!(modifiers(&["bogus".into()]).unwrap_err().kind, Kind::Invalid);
    }

    #[test]
    fn lone_modifier() {
        assert_eq!(combo("shift"), KeyCombo { modifiers: vec![], key: VK_SHIFT, extended: false });
        assert_eq!(combo("ctrl+alt"), KeyCombo { modifiers: vec![VK_CONTROL], key: VK_MENU, extended: false });
    }

    #[test]
    fn rejects() {
        for bad in ["win+r", "super", "meta+d", "Super_L", "fn+f1", "", "ctrl+", "hyper+a", "ctrl+bogus"] {
            let error = parse(bad, &[]).unwrap_err();
            assert_eq!(error.kind, Kind::Invalid, "{bad}");
        }
        assert!(parse("r", &["win".into()]).unwrap_err().message.contains("Windows key"));
    }
}
