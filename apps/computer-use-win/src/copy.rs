// 屏幕提示上的字。跟 Litch 的界面语言走（主进程在握手和改语言时告诉助手），只有中文和英文两种。

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Language {
    Zh,
    En,
}

/// 主进程给的语言名：zh 开头的算中文，别的一律英文
pub fn language(raw: Option<&str>) -> Language {
    match raw {
        Some(s) if s.to_lowercase().starts_with("zh") => Language::Zh,
        _ => Language::En,
    }
}

/// 提示条上的一行字：正在操作哪些应用、怎么停
pub fn banner(language: Language, apps: &[String]) -> String {
    match language {
        Language::Zh => format!("Litch 正在操作「{}」 · 按 Esc 停止", apps.join("、")),
        Language::En => format!("Litch is controlling {} · Press Esc to stop", apps.join(", ")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn picks_language() {
        assert_eq!(language(Some("zh-CN")), Language::Zh);
        assert_eq!(language(Some("ZH")), Language::Zh);
        assert_eq!(language(Some("en-US")), Language::En);
        assert_eq!(language(None), Language::En);
    }

    #[test]
    fn banners() {
        let apps = vec!["记事本".to_string(), "画图".to_string()];
        assert_eq!(banner(Language::Zh, &apps), "Litch 正在操作「记事本、画图」 · 按 Esc 停止");
        assert_eq!(banner(Language::En, &apps[..1]), "Litch is controlling 记事本 · Press Esc to stop");
    }
}
