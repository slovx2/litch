// 认应用：appId（打包应用是 AUMID，其余是 exe 的完整路径）比较时不分大小写；也接受应用名或 exe 文件名，
// 方便模型照着 list_apps 的显示名来叫。完整性级别的名字也在这里。
use crate::baseline::file_name;

/// 一个应用的几种叫法
pub struct AppNames<'a> {
    pub app_id: &'a str,
    pub name: &'a str,
    pub exe: &'a str,
}

/// 这个应用对不对得上：完全相同的 appId 最准（回 2），名字或 exe 文件名对上（回 1），否则 0
pub fn match_score(query: &str, app: &AppNames) -> u8 {
    let q = query.trim();
    if q.is_empty() {
        return 0;
    }
    if q.eq_ignore_ascii_case(app.app_id) || q.to_lowercase() == app.app_id.to_lowercase() {
        return 2;
    }
    let lower = q.to_lowercase();
    let exe = file_name(app.exe);
    if lower == app.name.to_lowercase() || lower == exe || format!("{lower}.exe") == exe {
        return 1;
    }
    0
}

/// 完整性级别的 RID → 名字（low / medium / high / system）
pub fn integrity_name(rid: u32) -> &'static str {
    match rid {
        0..=0x1FFF => "low",
        0x2000..=0x2FFF => "medium",
        0x3000..=0x3FFF => "high",
        _ => "system",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches() {
        let notepad = AppNames {
            app_id: "Microsoft.WindowsNotepad_8wekyb3d8bbwe!App",
            name: "记事本",
            exe: r"C:\Program Files\WindowsApps\Microsoft.WindowsNotepad_11.2607.14.0_x64__8wekyb3d8bbwe\Notepad\Notepad.exe",
        };
        assert_eq!(match_score("microsoft.windowsnotepad_8wekyb3d8bbwe!app", &notepad), 2);
        assert_eq!(match_score("记事本", &notepad), 1);
        assert_eq!(match_score("notepad", &notepad), 1);
        assert_eq!(match_score("Notepad.exe", &notepad), 1);
        assert_eq!(match_score("note", &notepad), 0);
        assert_eq!(match_score("", &notepad), 0);
        let code = AppNames { app_id: r"C:\VS Code\Code.exe", name: "Visual Studio Code", exe: r"C:\VS Code\Code.exe" };
        assert_eq!(match_score(r"c:\vs code\code.exe", &code), 2);
        assert_eq!(match_score("visual studio code", &code), 1);
    }

    #[test]
    fn integrity() {
        assert_eq!(integrity_name(0x1000), "low");
        assert_eq!(integrity_name(0x2000), "medium");
        assert_eq!(integrity_name(0x2100), "medium");
        assert_eq!(integrity_name(0x3000), "high");
        assert_eq!(integrity_name(0x4000), "system");
    }
}
