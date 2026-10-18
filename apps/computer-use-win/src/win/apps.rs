// 列应用、认应用、找窗口。
// - 应用号：打包应用用 AUMID，其余用 exe 的完整路径；显示名取打包应用在开始菜单里的名字或 exe 版本资源里的 FileDescription。
// - 窗口号：HWND 的数值。一个应用的窗口包括它的顶层窗口和带标题栏的对话框（被它拥有的窗口）；菜单、提示不算。
// - UWP 应用的顶层窗口属于 ApplicationFrameHost.exe，真正的应用在它的子窗口里，按子窗口的进程认。
// - 系统外壳（任务栏、桌面、开始菜单、输入法面板）和助手自己不列。
use super::system::{self, from_wide, open_process, process_exe, window_pid};
use crate::baseline;
use crate::fail;
use crate::geometry::Rect;
use crate::ident::{match_score, AppNames};
use crate::wire::RpcResult;
use std::collections::HashMap;
use windows::core::{BOOL, HSTRING, PWSTR};
use windows::Win32::Foundation::{HWND, LPARAM, RECT, TRUE};
use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED, DWMWA_EXTENDED_FRAME_BOUNDS};
use windows::Win32::Storage::Packaging::Appx::GetApplicationUserModelId;
use windows::Win32::System::Com::CoTaskMemFree;
use windows::Win32::UI::Shell::{IShellItem, SHCreateItemFromParsingName, SIGDN_NORMALDISPLAY};
use windows::Win32::UI::WindowsAndMessaging::*;

#[derive(Debug, Clone)]
pub struct Win {
    pub hwnd: isize,
    pub title: String,
    pub active: bool,
    pub minimized: bool,
    /// 被别的窗口拥有（对话框）
    pub owned: bool,
}

#[derive(Debug, Clone)]
pub struct App {
    pub app_id: String,
    pub name: String,
    pub exe: String,
    pub aumid: Option<String>,
    pub original_filename: Option<String>,
    pub pid: u32,
    pub integrity: u32,
    pub windows: Vec<Win>,
}

impl App {
    pub fn active(&self) -> bool {
        self.windows.iter().any(|w| w.active)
    }
}

pub fn hwnd(value: isize) -> HWND {
    HWND(value as *mut _)
}

pub fn title(h: HWND) -> String {
    let mut buf = [0u16; 512];
    let n = unsafe { GetWindowTextW(h, &mut buf) };
    String::from_utf16_lossy(&buf[..n.max(0) as usize])
}

pub fn class(h: HWND) -> String {
    let mut buf = [0u16; 256];
    let n = unsafe { GetClassNameW(h, &mut buf) };
    String::from_utf16_lossy(&buf[..n.max(0) as usize])
}

/// 窗口在屏幕上看得见的边界（不含阴影），物理像素
pub fn bounds(h: HWND) -> Rect {
    let mut r = RECT::default();
    let ok = unsafe {
        DwmGetWindowAttribute(h, DWMWA_EXTENDED_FRAME_BOUNDS, &mut r as *mut RECT as *mut _, std::mem::size_of::<RECT>() as u32)
    };
    if ok.is_err() {
        unsafe {
            let _ = GetWindowRect(h, &mut r);
        }
    }
    Rect::new(r.left, r.top, r.right, r.bottom)
}

fn cloaked(h: HWND) -> bool {
    let mut value = 0u32;
    unsafe {
        let _ = DwmGetWindowAttribute(h, DWMWA_CLOAKED, &mut value as *mut u32 as *mut _, 4);
    }
    value != 0
}

pub fn is_alive(h: HWND) -> bool {
    unsafe { IsWindow(Some(h)).as_bool() }
}

/// 最小化的窗口还原（取状态、截图前用），不抢焦点
pub fn restore(h: HWND) {
    if unsafe { IsIconic(h) }.as_bool() {
        unsafe {
            let _ = ShowWindow(h, SW_SHOWNOACTIVATE);
        }
    }
}

/// 窗口的根（顶层）窗口
pub fn root(h: HWND) -> HWND {
    let r = unsafe { GetAncestor(h, GA_ROOT) };
    if r.is_invalid() {
        h
    } else {
        r
    }
}

/// 按 Z 序（从上到下）列出所有顶层窗口
pub fn top_level() -> Vec<HWND> {
    unsafe extern "system" fn collect(h: HWND, l: LPARAM) -> BOOL {
        let list = &mut *(l.0 as *mut Vec<HWND>);
        list.push(h);
        TRUE
    }
    let mut list: Vec<HWND> = vec![];
    unsafe {
        let _ = EnumWindows(Some(collect), LPARAM(&mut list as *mut Vec<HWND> as isize));
    }
    list
}

/// 能不能算作一个应用窗口：看得见、没被隐藏到别的桌面、不是工具窗口；被拥有的窗口要有标题栏（对话框）
fn app_window(h: HWND) -> Option<bool> {
    unsafe {
        if !IsWindowVisible(h).as_bool() || cloaked(h) {
            return None;
        }
        let style = GetWindowLongW(h, GWL_STYLE) as u32;
        let ex = GetWindowLongW(h, GWL_EXSTYLE) as u32;
        let owner = GetWindow(h, GW_OWNER).unwrap_or_default();
        let owned = !owner.is_invalid();
        if ex & WS_EX_TOOLWINDOW.0 != 0 && ex & WS_EX_APPWINDOW.0 == 0 {
            return None;
        }
        if owned && style & WS_CAPTION.0 != WS_CAPTION.0 {
            return None;
        }
        if baseline::is_shell_class(&class(h)) {
            return None;
        }
        let r = bounds(h);
        if r.width() < 2 || r.height() < 2 {
            return None;
        }
        Some(owned)
    }
}

/// UWP 应用：ApplicationFrameHost 的顶层窗口里，进程不同的那个子窗口才是应用
fn frame_child_pid(h: HWND, host: u32) -> Option<u32> {
    unsafe extern "system" fn find(h: HWND, l: LPARAM) -> BOOL {
        let (host, out) = &mut *(l.0 as *mut (u32, u32));
        let pid = window_pid(h);
        if pid != *host {
            *out = pid;
            return BOOL(0);
        }
        TRUE
    }
    let mut state = (host, 0u32);
    unsafe {
        let _ = EnumChildWindows(Some(h), Some(find), LPARAM(&mut state as *mut (u32, u32) as isize));
    }
    (state.1 != 0).then_some(state.1)
}

fn aumid_of(process: &system::Handle) -> Option<String> {
    let mut buf = vec![0u16; 512];
    let mut len = buf.len() as u32;
    let rc = unsafe { GetApplicationUserModelId(process.0, &mut len, Some(PWSTR(buf.as_mut_ptr()))) };
    (rc.0 == 0).then(|| from_wide(&buf)).filter(|s| !s.is_empty())
}

/// 打包应用在开始菜单里的名字
fn aumid_display_name(aumid: &str) -> Option<String> {
    unsafe {
        let item: IShellItem =
            SHCreateItemFromParsingName(&HSTRING::from(format!("shell:AppsFolder\\{aumid}")), None).ok()?;
        let name = item.GetDisplayName(SIGDN_NORMALDISPLAY).ok()?;
        let text = name.to_string().ok();
        CoTaskMemFree(Some(name.0 as *const _));
        text.filter(|s| !s.is_empty())
    }
}

/// 一个进程对应的应用身份（不含窗口）
fn identify(pid: u32, cache: &mut HashMap<u32, Option<App>>) -> Option<App> {
    if let Some(found) = cache.get(&pid) {
        return found.clone();
    }
    let found = (|| {
        let process = open_process(pid)?;
        let exe = process_exe(&process)?;
        let aumid = aumid_of(&process);
        let original_filename = system::version_string(&exe, "OriginalFilename");
        let name = aumid
            .as_deref()
            .and_then(aumid_display_name)
            .or_else(|| system::version_string(&exe, "FileDescription"))
            .unwrap_or_else(|| {
                let file = baseline::file_name(&exe);
                file.strip_suffix(".exe").unwrap_or(&file).to_string()
            });
        Some(App {
            app_id: aumid.clone().unwrap_or_else(|| exe.clone()),
            name,
            exe,
            aumid,
            original_filename,
            pid,
            integrity: system::integrity_rid(&process).unwrap_or(0x2000),
            windows: vec![],
        })
    })();
    cache.insert(pid, found.clone());
    found
}

/// 有可见窗口的应用，按最近激活的窗口排（Z 序靠上的在前）
pub fn list() -> Vec<App> {
    let own = std::process::id();
    let foreground = root(unsafe { GetForegroundWindow() });
    let mut cache: HashMap<u32, Option<App>> = HashMap::new();
    let mut apps: Vec<App> = vec![];
    for h in top_level() {
        let Some(owned) = app_window(h) else { continue };
        let mut pid = window_pid(h);
        if pid == own {
            continue;
        }
        let Some(mut identity) = identify(pid, &mut cache) else { continue };
        if baseline::file_name(&identity.exe) == "applicationframehost.exe" {
            let Some(child) = frame_child_pid(h, pid) else { continue };
            pid = child;
            let Some(real) = identify(pid, &mut cache) else { continue };
            identity = real;
        }
        if baseline::is_shell_exe(&identity.exe) {
            continue;
        }
        let text = title(h);
        if text.is_empty() && !owned {
            continue;
        }
        let win = Win {
            hwnd: h.0 as isize,
            title: text,
            active: h == foreground,
            minimized: unsafe { IsIconic(h).as_bool() },
            owned,
        };
        match apps.iter_mut().find(|a| a.app_id.eq_ignore_ascii_case(&identity.app_id)) {
            Some(app) => app.windows.push(win),
            None => {
                identity.windows.push(win);
                apps.push(identity);
            }
        }
    }
    apps
}

/// 按应用号（或应用名、exe 名）找应用，再挑窗口：给了窗口号就要它属于这个应用，不给就用最近激活的那个
pub fn resolve(query: &str, window: Option<isize>) -> RpcResult<(App, Win)> {
    let apps = list();
    let mut best: Option<(u8, &App)> = None;
    for app in &apps {
        let score = match_score(query, &AppNames { app_id: &app.app_id, name: &app.name, exe: &app.exe });
        if score > 0 && best.is_none_or(|(s, _)| score > s) {
            best = Some((score, app));
        }
    }
    let Some((_, app)) = best else {
        return Err(fail!(NotFound, "No open window belongs to \"{query}\". Call list_apps to see the apps that have windows."));
    };
    let win = match window {
        Some(id) => app.windows.iter().find(|w| w.hwnd == id).cloned().ok_or_else(|| {
            fail!(NotFound, "Window {id} is not an open window of {}. Call list_apps or get_app_state to see its windows.", app.name)
        })?,
        // 没给窗口号：优先不是对话框的那个最上面的窗口；只有对话框时用对话框
        None => app.windows.iter().find(|w| !w.owned).or(app.windows.first()).cloned().ok_or_else(|| {
            fail!(NotFound, "{} has no open window.", app.name)
        })?,
    };
    Ok((app.clone(), win))
}

/// 同一进程里盖在窗口上面的弹出层（菜单、下拉框、提示），截图时叠进去。按 Z 序从下到上给出
pub fn popups(target: HWND, pid: u32) -> Vec<HWND> {
    let mut found = vec![];
    for h in top_level() {
        if h == target {
            break;
        }
        if window_pid(h) != pid || !unsafe { IsWindowVisible(h).as_bool() } || cloaked(h) {
            continue;
        }
        let style = unsafe { GetWindowLongW(h, GWL_STYLE) } as u32;
        let is_menu = class(h) == "#32768";
        let popup_without_caption = style & WS_POPUP.0 != 0 && style & WS_CAPTION.0 != WS_CAPTION.0;
        if is_menu || popup_without_caption {
            found.push(h);
        }
    }
    found.reverse();
    found
}
