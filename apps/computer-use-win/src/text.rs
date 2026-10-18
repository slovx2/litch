// 打字的拆分和长文字的截断。
// type_text 用 KEYEVENTF_UNICODE 逐个 UTF-16 码元发（中文不经输入法）；换行、制表符按真实的键发，
// 否则很多控件收到 Unicode 的 \n 不会换行。
use crate::keys::{VK_RETURN, VK_TAB};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TypeStep {
    /// 一个 UTF-16 码元（代理对拆成两个，按顺序发）
    Unit(u16),
    /// 一个虚拟键（回车、Tab）
    Key(u16),
}

pub fn plan(text: &str) -> Vec<TypeStep> {
    let mut steps = vec![];
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\r' => {
                // \r\n 算一次回车
                if chars.peek() == Some(&'\n') {
                    chars.next();
                }
                steps.push(TypeStep::Key(VK_RETURN));
            }
            '\n' => steps.push(TypeStep::Key(VK_RETURN)),
            '\t' => steps.push(TypeStep::Key(VK_TAB)),
            _ => {
                let mut buf = [0u16; 2];
                for unit in c.encode_utf16(&mut buf) {
                    steps.push(TypeStep::Unit(*unit));
                }
            }
        }
    }
    steps
}

/// 截到最多 `max` 个字符，截了就在末尾加省略号
pub fn clip(text: &str, max: usize) -> String {
    let mut out: String = text.chars().take(max).collect();
    if text.chars().nth(max).is_some() {
        out.push('…');
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_text() {
        assert_eq!(plan("a中"), vec![TypeStep::Unit(0x61), TypeStep::Unit(0x4E2D)]);
        assert_eq!(plan("x\r\ny\nz\tw\r"), vec![
            TypeStep::Unit(0x78),
            TypeStep::Key(VK_RETURN),
            TypeStep::Unit(0x79),
            TypeStep::Key(VK_RETURN),
            TypeStep::Unit(0x7A),
            TypeStep::Key(VK_TAB),
            TypeStep::Unit(0x77),
            TypeStep::Key(VK_RETURN),
        ]);
        // 代理对
        assert_eq!(plan("😀"), vec![TypeStep::Unit(0xD83D), TypeStep::Unit(0xDE00)]);
        assert!(plan("").is_empty());
    }

    #[test]
    fn clips() {
        assert_eq!(clip("abc", 3), "abc");
        assert_eq!(clip("abcd", 3), "abc…");
        assert_eq!(clip("你好世界", 2), "你好…");
    }
}
