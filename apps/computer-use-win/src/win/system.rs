// 系统信息与小工具：日志、宽字符串、进程的 exe 与完整性级别、输入桌面、系统版本、UAC、单实例互斥量。
use crate::ident::integrity_name;
use std::ffi::c_void;
use windows::core::{HSTRING, PCWSTR, PWSTR};
use windows::Win32::Foundation::{CloseHandle, GetLastError, ERROR_ALREADY_EXISTS, HANDLE, HWND};
use windows::Win32::Security::Authorization::ConvertSidToStringSidW;
use windows::Win32::Security::{
    GetSidSubAuthority, GetSidSubAuthorityCount, GetTokenInformation, TokenIntegrityLevel, TokenUser, TOKEN_MANDATORY_LABEL,
    TOKEN_QUERY, TOKEN_USER,
};
use windows::Win32::Storage::FileSystem::{GetFileVersionInfoSizeW, GetFileVersionInfoW, VerQueryValueW};
use windows::Win32::System::Registry::{RegGetValueW, HKEY_LOCAL_MACHINE, RRF_RT_REG_DWORD, RRF_RT_REG_SZ};
use windows::Win32::System::StationsAndDesktops::{CloseDesktop, GetUserObjectInformationW, OpenInputDesktop, UOI_NAME};
use windows::Win32::System::StationsAndDesktops::{DESKTOP_ACCESS_FLAGS, DESKTOP_CONTROL_FLAGS};
use windows::Win32::System::Threading::{
    CreateMutexW, GetCurrentProcess, OpenProcess, OpenProcessToken, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
    PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowThreadProcessId};

/// 写一行日志到标准错误（主进程转进 [computer-use] 日志）
pub fn log(message: impl AsRef<str>) {
    use std::io::Write;
    let _ = writeln!(std::io::stderr(), "{}", message.as_ref());
}

pub fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(std::iter::once(0)).collect()
}

pub fn from_wide(buf: &[u16]) -> String {
    let end = buf.iter().position(|c| *c == 0).unwrap_or(buf.len());
    String::from_utf16_lossy(&buf[..end])
}

/// 自动关掉的句柄
pub struct Handle(pub HANDLE);

impl Drop for Handle {
    fn drop(&mut self) {
        if !self.0.is_invalid() {
            unsafe {
                let _ = CloseHandle(self.0);
            }
        }
    }
}

pub fn open_process(pid: u32) -> Option<Handle> {
    unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok().map(Handle) }
}

/// 进程的 exe 完整路径
pub fn process_exe(process: &Handle) -> Option<String> {
    let mut buf = vec![0u16; 1024];
    let mut len = buf.len() as u32;
    unsafe { QueryFullProcessImageNameW(process.0, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut len).ok()? };
    Some(String::from_utf16_lossy(&buf[..len as usize]))
}

pub fn window_pid(hwnd: HWND) -> u32 {
    let mut pid = 0;
    unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };
    pid
}

/// 进程令牌的完整性级别（RID：0x2000 普通、0x3000 管理员……）
pub fn integrity_rid(process: &Handle) -> Option<u32> {
    unsafe {
        let mut token = HANDLE::default();
        OpenProcessToken(process.0, TOKEN_QUERY, &mut token).ok()?;
        let token = Handle(token);
        let mut need = 0u32;
        let _ = GetTokenInformation(token.0, TokenIntegrityLevel, None, 0, &mut need);
        let mut buf = vec![0u8; need as usize];
        GetTokenInformation(token.0, TokenIntegrityLevel, Some(buf.as_mut_ptr() as *mut c_void), need, &mut need).ok()?;
        let label = &*(buf.as_ptr() as *const TOKEN_MANDATORY_LABEL);
        let sid = label.Label.Sid;
        let count = *GetSidSubAuthorityCount(sid);
        if count == 0 {
            return None;
        }
        Some(*GetSidSubAuthority(sid, (count - 1) as u32))
    }
}

pub fn own_process() -> Handle {
    // 伪句柄不用关；包一层只为和别的进程同一套函数，Drop 时 CloseHandle 对伪句柄无害
    Handle(unsafe { GetCurrentProcess() })
}

pub fn own_integrity() -> u32 {
    integrity_rid(&own_process()).unwrap_or(0x2000)
}

pub fn integrity_of_pid(pid: u32) -> Option<u32> {
    open_process(pid).and_then(|p| integrity_rid(&p))
}

pub fn integrity_label(rid: u32) -> &'static str {
    integrity_name(rid)
}

/// 当前用户的 SID 字符串（单实例互斥量的名字用）
pub fn user_sid() -> Option<String> {
    unsafe {
        let mut token = HANDLE::default();
        OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token).ok()?;
        let token = Handle(token);
        let mut need = 0u32;
        let _ = GetTokenInformation(token.0, TokenUser, None, 0, &mut need);
        let mut buf = vec![0u8; need as usize];
        GetTokenInformation(token.0, TokenUser, Some(buf.as_mut_ptr() as *mut c_void), need, &mut need).ok()?;
        let user = &*(buf.as_ptr() as *const TOKEN_USER);
        let mut text = PWSTR::null();
        ConvertSidToStringSidW(user.User.Sid, &mut text).ok()?;
        let out = text.to_string().ok();
        windows::Win32::Foundation::LocalFree(Some(windows::Win32::Foundation::HLOCAL(text.0 as *mut c_void)));
        out
    }
}

/// 单实例：拿到互斥量回 Some（句柄要一直留着），已有别的实例回 None
pub fn single_instance() -> Option<Handle> {
    let name = format!("Local\\LitchComputerUse-{}", user_sid().unwrap_or_else(|| "unknown".into()));
    unsafe {
        let handle = CreateMutexW(None, true, &HSTRING::from(name)).ok()?;
        if GetLastError() == ERROR_ALREADY_EXISTS {
            let _ = CloseHandle(handle);
            return None;
        }
        Some(Handle(handle))
    }
}

/// 接收输入的桌面的名字：平时是 Default，锁屏或 UAC 提示时是 Winlogon；打不开（安全桌面上）回 None
pub fn input_desktop() -> Option<String> {
    unsafe {
        // DESKTOP_READOBJECTS
        let desktop = OpenInputDesktop(DESKTOP_CONTROL_FLAGS(0), false, DESKTOP_ACCESS_FLAGS(0x0001)).ok()?;
        let mut buf = [0u16; 256];
        let mut need = 0u32;
        let ok = GetUserObjectInformationW(
            HANDLE(desktop.0),
            UOI_NAME,
            Some(buf.as_mut_ptr() as *mut c_void),
            (buf.len() * 2) as u32,
            Some(&mut need),
        );
        let _ = CloseDesktop(desktop);
        ok.ok()?;
        Some(from_wide(&buf))
    }
}

/// 桌面锁着（输入桌面不是 Default，或前台是锁屏应用）时回说明，否则 None
pub fn locked_reason() -> Option<String> {
    match input_desktop() {
        Some(name) if name.eq_ignore_ascii_case("Default") => {}
        Some(name) => return Some(format!("input desktop is {name}")),
        None => return Some("input desktop is not accessible".into()),
    }
    let fg = unsafe { GetForegroundWindow() };
    if !fg.is_invalid() {
        if let Some(exe) = open_process(window_pid(fg)).and_then(|p| process_exe(&p)) {
            if crate::baseline::file_name(&exe) == "lockapp.exe" {
                return Some("the lock screen is in front".into());
            }
        }
    }
    None
}

fn reg_string(key: &str, value: &str) -> Option<String> {
    let mut buf = vec![0u16; 256];
    let mut size = (buf.len() * 2) as u32;
    unsafe {
        RegGetValueW(
            HKEY_LOCAL_MACHINE,
            &HSTRING::from(key),
            &HSTRING::from(value),
            RRF_RT_REG_SZ,
            None,
            Some(buf.as_mut_ptr() as *mut c_void),
            Some(&mut size),
        )
        .ok()
        .ok()?;
    }
    Some(from_wide(&buf))
}

fn reg_dword(key: &str, value: &str) -> Option<u32> {
    let mut data = 0u32;
    let mut size = 4u32;
    unsafe {
        RegGetValueW(
            HKEY_LOCAL_MACHINE,
            &HSTRING::from(key),
            &HSTRING::from(value),
            RRF_RT_REG_DWORD,
            None,
            Some(&mut data as *mut u32 as *mut c_void),
            Some(&mut size),
        )
        .ok()
        .ok()?;
    }
    Some(data)
}

/// 系统版本，如 10.0.26300.1000
pub fn os_version() -> String {
    let key = r"SOFTWARE\Microsoft\Windows NT\CurrentVersion";
    let build = reg_string(key, "CurrentBuildNumber").unwrap_or_else(|| "?".into());
    match reg_dword(key, "UBR") {
        Some(ubr) => format!("10.0.{build}.{ubr}"),
        None => format!("10.0.{build}"),
    }
}

/// UAC 开着没有（EnableLUA，读不到按开着算）
pub fn uac_enabled() -> bool {
    reg_dword(r"SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System", "EnableLUA").map(|v| v != 0).unwrap_or(true)
}

/// exe 版本资源里的一项字符串（FileDescription、OriginalFilename……），按文件自己声明的第一种语言取
pub fn version_string(exe: &str, field: &str) -> Option<String> {
    unsafe {
        let path = HSTRING::from(exe);
        let size = GetFileVersionInfoSizeW(&path, None);
        if size == 0 {
            return None;
        }
        let mut data = vec![0u8; size as usize];
        GetFileVersionInfoW(&path, None, size, data.as_mut_ptr() as *mut c_void).ok()?;
        let mut ptr: *mut c_void = std::ptr::null_mut();
        let mut len = 0u32;
        let mut candidates = vec![];
        if VerQueryValueW(data.as_ptr() as *const c_void, &HSTRING::from(r"\VarFileInfo\Translation"), &mut ptr, &mut len)
            .as_bool()
            && len >= 4
        {
            let pairs = std::slice::from_raw_parts(ptr as *const u16, (len / 2) as usize);
            for pair in pairs.chunks(2) {
                if pair.len() == 2 {
                    candidates.push(format!("{:04x}{:04x}", pair[0], pair[1]));
                }
            }
        }
        candidates.extend(["040904b0".to_string(), "040904e4".to_string(), "000004b0".to_string()]);
        for lang in candidates {
            let query = HSTRING::from(format!(r"\StringFileInfo\{lang}\{field}"));
            if VerQueryValueW(data.as_ptr() as *const c_void, &query, &mut ptr, &mut len).as_bool() && len > 0 {
                let text = from_wide(std::slice::from_raw_parts(ptr as *const u16, len as usize)).trim().to_string();
                if !text.is_empty() {
                    return Some(text);
                }
            }
        }
        None
    }
}

/// 给 PCWSTR 参数用的宽字符串（调用期间要活着）
pub fn pcwstr(buf: &[u16]) -> PCWSTR {
    PCWSTR(buf.as_ptr())
}
