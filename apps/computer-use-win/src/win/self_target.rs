// 从安装器登记的正式路径识别应用，不把便携构建和 Electron 开发进程当成正式版。
// 隔离状态只在目标进程的环境里找，只判断隔离标识，不记录或输出环境内容，也不信任工具参数。
use super::system::{from_wide, Handle};
use std::ffi::c_void;
use windows::core::HSTRING;
use windows::Win32::Foundation::HANDLE;
use windows::Win32::System::Diagnostics::Debug::ReadProcessMemory;
use windows::Win32::System::Registry::{
    RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_SZ, RRF_SUBKEY_WOW6464KEY,
};
use windows::Win32::System::Threading::{
    OpenProcess, PROCESS_BASIC_INFORMATION, PROCESS_QUERY_INFORMATION, PROCESS_VM_READ,
    RTL_USER_PROCESS_PARAMETERS,
};

#[link(name = "ntdll")]
extern "system" {
    fn NtQueryInformationProcess(
        process: HANDLE,
        class: u32,
        info: *mut c_void,
        size: u32,
        written: *mut u32,
    ) -> i32;
}

fn installed_exe() -> Option<String> {
    let key = HSTRING::from(env!("CU_HOST_REGISTRY_KEY"));
    let mut data = vec![0u16; 32768];
    let mut bytes = (data.len() * 2) as u32;
    unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            &key,
            &HSTRING::from("InstallLocation"),
            RRF_RT_REG_SZ | RRF_SUBKEY_WOW6464KEY,
            None,
            Some(data.as_mut_ptr().cast()),
            Some(&mut bytes),
        )
        .ok()
        .ok()?;
    }
    let directory = from_wide(&data);
    if directory.is_empty() {
        return None;
    }
    Some(format!(
        "{}\\{}",
        directory.trim_end_matches(['\\', '/']), env!("CU_HOST_EXECUTABLE")
    ))
}

unsafe fn read<T: Copy + Default>(process: HANDLE, address: *const c_void) -> Option<T> {
    let mut value = T::default();
    let mut bytes = 0;
    ReadProcessMemory(
        process,
        address,
        (&mut value as *mut T).cast(),
        std::mem::size_of::<T>(),
        Some(&mut bytes),
    )
    .ok()?;
    (bytes == std::mem::size_of::<T>()).then_some(value)
}

fn isolated(pid: u32) -> Option<bool> {
    // 本项目只发布 x64 助手和 x64 Litch。环境指针紧接 Windows 原生进程参数的 CommandLine；
    // 读取失败不豁免，未知布局也不能变成无授权访问。
    unsafe {
        let process =
            Handle(OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, false, pid).ok()?);
        let mut basic = PROCESS_BASIC_INFORMATION::default();
        if NtQueryInformationProcess(
            process.0,
            0,
            (&mut basic as *mut PROCESS_BASIC_INFORMATION).cast(),
            std::mem::size_of_val(&basic) as u32,
            std::ptr::null_mut(),
        ) < 0
        {
            return None;
        }
        let peb =
            read::<windows::Win32::System::Threading::PEB>(process.0, basic.PebBaseAddress.cast())?;
        let pointer = (peb.ProcessParameters as usize)
            .checked_add(std::mem::size_of::<RTL_USER_PROCESS_PARAMETERS>())?;
        let environment = read::<usize>(process.0, pointer as *const c_void)?;
        if environment == 0 {
            return None;
        }
        let mut values = Vec::new();
        // 每块不跨页，遇到双零立即停；上限 1 MiB，不扫描目标的其他内存。
        while values.len() < 512 * 1024 {
            let address = environment.checked_add(values.len() * 2)?;
            let count = ((4096 - address % 4096) / 2).min(256);
            let mut chunk = vec![0u16; count];
            let mut bytes = 0;
            ReadProcessMemory(
                process.0,
                address as *const c_void,
                chunk.as_mut_ptr().cast(),
                count * 2,
                Some(&mut bytes),
            )
            .ok()?;
            if bytes != count * 2 {
                return None;
            }
            for unit in chunk {
                if unit == 0 && values.last() == Some(&0) {
                    return Some(crate::ident::isolated_environment(&values));
                }
                values.push(unit);
            }
        }
        None
    }
}

pub fn protected(exe: &str, pid: u32) -> bool {
    let installed = installed_exe();
    if !crate::ident::is_protected_target(exe, installed.as_deref(), false) {
        return false;
    }
    crate::ident::is_protected_target(exe, installed.as_deref(), isolated(pid).unwrap_or(false))
}
