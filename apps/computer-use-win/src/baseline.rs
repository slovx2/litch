// 助手这一侧的名单。
//
// 底线名单：无论主进程怎么说都不操作的程序。完整的名单（禁止和高风险）和审批在主进程的 policy-win.mts，
// 这里只留最要紧的几类，防的是主进程那一侧出了错：Litch 自己和本助手、系统的凭据与提权界面、锁屏。
// 两边的名单改的时候一起看：这里的每一项主进程那份名单里都要有。
//
// 外壳名单：属于系统外壳的进程和窗口类，不算“应用”，不出现在 listApps 里（任务栏、桌面、开始菜单、输入法面板等）。

/// 底线名单（exe 文件名，小写）
pub const FORBIDDEN_EXES: &[&str] = &[
    "litch.exe",
    "litch-computer-use.exe",
    "consent.exe",
    "credentialuibroker.exe",
    "logonui.exe",
    "lockapp.exe",
];

/// 系统外壳进程（exe 文件名，小写）：它们的窗口不列为应用
pub const SHELL_EXES: &[&str] = &[
    "shellexperiencehost.exe",
    "startmenuexperiencehost.exe",
    "searchhost.exe",
    "searchapp.exe",
    "searchui.exe",
    "textinputhost.exe",
    "lockapp.exe",
    "sihost.exe",
    "ctfmon.exe",
    "runtimebroker.exe",
    "backgroundtaskhost.exe",
    "tabtip.exe",
    "dwm.exe",
    "shellhost.exe",
    "widgets.exe",
    "widgetboard.exe",
    "windowsinternal.composableshell.experiences.textinput.inputapp.exe",
    "screenclippinghost.exe",
    "clicktodo.exe",
];

/// 系统外壳的窗口类：资源管理器进程里的桌面、任务栏不算应用（文件资源管理器的窗口类是 CabinetWClass，照常列）
pub const SHELL_CLASSES: &[&str] = &[
    "Progman",
    "WorkerW",
    "Shell_TrayWnd",
    "Shell_SecondaryTrayWnd",
    "NotifyIconOverflowWindow",
    "Windows.UI.Core.CoreWindow",
    "XamlExplorerHostIslandWindow",
    "TopLevelWindowForOverflowXamlIsland",
];

/// 路径或文件名 → 小写的文件名
pub fn file_name(path: &str) -> String {
    path.rsplit(['\\', '/']).next().unwrap_or(path).to_lowercase()
}

/// 底线名单：exe 的文件名或版本资源里的 OriginalFilename（防改名）命中任一项
pub fn is_forbidden(exe: &str, original_filename: Option<&str>) -> bool {
    let hit = |name: &str| FORBIDDEN_EXES.contains(&file_name(name).as_str());
    hit(exe) || original_filename.is_some_and(|name| !name.is_empty() && hit(name))
}

pub fn is_shell_exe(exe: &str) -> bool {
    SHELL_EXES.contains(&file_name(exe).as_str())
}

pub fn is_shell_class(class: &str) -> bool {
    SHELL_CLASSES.iter().any(|c| c.eq_ignore_ascii_case(class))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn forbidden() {
        assert!(is_forbidden(r"C:\Users\a\AppData\Local\Programs\Litch\Litch.exe", None));
        assert!(is_forbidden(r"C:\Windows\System32\consent.exe", None));
        assert!(is_forbidden(r"C:\x\resources\computer-use\litch-computer-use.exe", None));
        assert!(is_forbidden("LOGONUI.EXE", None));
        // 改了名的副本按版本资源认
        assert!(is_forbidden(r"C:\tmp\renamed.exe", Some("CredentialUIBroker.exe")));
        assert!(!is_forbidden(r"C:\Windows\notepad.exe", Some("NOTEPAD.EXE")));
        assert!(!is_forbidden(r"C:\Windows\notepad.exe", Some("")));
    }

    #[test]
    fn shell() {
        assert!(is_shell_exe(r"C:\Windows\SystemApps\ShellExperienceHost_cw5n1h2txyewy\ShellExperienceHost.exe"));
        assert!(!is_shell_exe(r"C:\Windows\explorer.exe"));
        assert!(is_shell_class("Shell_TrayWnd"));
        assert!(is_shell_class("progman"));
        assert!(!is_shell_class("CabinetWClass"));
    }

    #[test]
    fn names() {
        assert_eq!(file_name(r"C:\A\B.EXE"), "b.exe");
        assert_eq!(file_name("c/d.exe"), "d.exe");
        assert_eq!(file_name("e.exe"), "e.exe");
    }
}
