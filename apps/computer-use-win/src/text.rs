// 打字的拆分和长文字的截断。
// type_text 把文字拆成一次一个“键击”：一个字符用 KEYEVENTF_UNICODE 发（中文不经输入法，代理对由调用方
// encode_utf16 成两个码元一起发），换行、制表符按真实的键发（很多控件收到 Unicode 的 \n 不会换行）。
// 一次一个键击分开发、中间留间隔，是因为一次 SendInput 把整串发太快时，记事本这类 TSF 控件会吞字或把字
// 替换成最后一个字的重复。
use crate::keys::{VK_RETURN, VK_TAB};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Keystroke {
    /// 一个字符（代理对由调用方 encode_utf16 成一到两个 UTF-16 码元）
    Char(char),
    /// 一个虚拟键（回车、Tab）
    Key(u16),
}

pub fn keystrokes(text: &str) -> Vec<Keystroke> {
    let mut steps = vec![];
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\r' => {
                // \r\n 算一次回车
                if chars.peek() == Some(&'\n') {
                    chars.next();
                }
                steps.push(Keystroke::Key(VK_RETURN));
            }
            '\n' => steps.push(Keystroke::Key(VK_RETURN)),
            '\t' => steps.push(Keystroke::Key(VK_TAB)),
            _ => steps.push(Keystroke::Char(c)),
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
        assert_eq!(keystrokes("a中"), vec![Keystroke::Char('a'), Keystroke::Char('中')]);
        assert_eq!(keystrokes("x\r\ny\nz\tw\r"), vec![
            Keystroke::Char('x'),
            Keystroke::Key(VK_RETURN),
            Keystroke::Char('y'),
            Keystroke::Key(VK_RETURN),
            Keystroke::Char('z'),
            Keystroke::Key(VK_TAB),
            Keystroke::Char('w'),
            Keystroke::Key(VK_RETURN),
        ]);
        // 代理对：一个字符，encode_utf16 交给调用方
        assert_eq!(keystrokes("😀"), vec![Keystroke::Char('😀')]);
        assert_eq!('😀'.encode_utf16(&mut [0u16; 2]), [0xD83D, 0xDE00]);
        assert!(keystrokes("").is_empty());
    }

    #[test]
    fn clips() {
        assert_eq!(clip("abc", 3), "abc");
        assert_eq!(clip("abcd", 3), "abc…");
        assert_eq!(clip("你好世界", 2), "你好…");
    }
}
