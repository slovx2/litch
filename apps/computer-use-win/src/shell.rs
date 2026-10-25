// 属于系统外壳的进程和窗口类：不算“应用”，不出现在 listApps 里（任务栏、桌面、开始菜单、输入法面板等）。
// 这不是禁止名单：所有应用都能操作。

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
