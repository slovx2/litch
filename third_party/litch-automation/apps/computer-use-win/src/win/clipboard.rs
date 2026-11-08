// 剪贴板读写：type_text 走剪贴板 + Ctrl+V 时用（记事本这类 TSF 控件逐字发会吞字，用粘贴稳）。
// 只管 CF_UNICODETEXT 文本；图片等其它格式不保存、不恢复。
use windows::Win32::Foundation::{HANDLE, HGLOBAL};
use windows::Win32::System::DataExchange::{CloseClipboard, EmptyClipboard, GetClipboardData, OpenClipboard, SetClipboardData};
use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};
use windows::Win32::System::Ole::CF_UNICODETEXT;

const CF_TEXT: u32 = CF_UNICODETEXT.0 as u32;

/// 读剪贴板里的 Unicode 文本；没有文本或打不开回 None
pub fn get_text() -> Option<String> {
    unsafe {
        OpenClipboard(None).ok()?;
        let result = (|| {
            let handle = GetClipboardData(CF_TEXT).ok()?;
            if handle.0.is_null() {
                return None;
            }
            let hglobal = HGLOBAL(handle.0);
            let ptr = GlobalLock(hglobal) as *const u16;
            if ptr.is_null() {
                return None;
            }
            let mut len = 0usize;
            while *ptr.add(len) != 0 {
                len += 1;
            }
            let text = String::from_utf16_lossy(std::slice::from_raw_parts(ptr, len));
            let _ = GlobalUnlock(hglobal);
            Some(text)
        })();
        let _ = CloseClipboard();
        result
    }
}

/// 把 Unicode 文本写进剪贴板，成功回 true
pub fn set_text(text: &str) -> bool {
    let mut units: Vec<u16> = text.encode_utf16().collect();
    units.push(0);
    let bytes = units.len() * 2;
    unsafe {
        if OpenClipboard(None).is_err() {
            return false;
        }
        let ok = (|| {
            EmptyClipboard().ok()?;
            let hglobal = GlobalAlloc(GMEM_MOVEABLE, bytes).ok()?;
            let dst = GlobalLock(hglobal) as *mut u16;
            if dst.is_null() {
                return None;
            }
            std::ptr::copy_nonoverlapping(units.as_ptr(), dst, units.len());
            let _ = GlobalUnlock(hglobal);
            // 所有权交给剪贴板，成功之后不自己释放
            SetClipboardData(CF_TEXT, Some(HANDLE(hglobal.0))).ok()?;
            Some(())
        })()
        .is_some();
        let _ = CloseClipboard();
        ok
    }
}
