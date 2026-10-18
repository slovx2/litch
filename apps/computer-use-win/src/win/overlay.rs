// 屏幕提示：一个置顶、点击穿透、不抢焦点的分层窗口，沿目标窗口画一圈边框，顶部一条
// “Litch 正在使用此电脑 · 按 Esc 停止”。内容、要不要显示、跟着哪个窗口都来自 activity::overlay_target()。
// 单独一条线程持有窗口并跑消息循环：定时（每 250 ms）复看一次，activity 变化时 wake() 催一次即时更新。
// 不设 WDA_EXCLUDEFROMCAPTURE：我们自己的截图只截目标窗口（capture.rs 的 CreateForWindow / PrintWindow，
// 贴弹出层也只贴目标进程的窗口），提示窗口本来就进不去；留着这个标志只会让串流/远程软件的画面里也看不到提示。
use super::{activity, apps};
use crate::geometry::Rect;
use std::sync::atomic::{AtomicBool, AtomicIsize, AtomicU32, Ordering};
use windows::core::w;
use windows::Win32::Foundation::{GetLastError, COLORREF, HWND, LPARAM, LRESULT, POINT, SIZE, WPARAM};
use windows::Win32::Graphics::Gdi::*;
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::Threading::GetCurrentThreadId;
use windows::Win32::UI::WindowsAndMessaging::*;

const WM_WAKE: u32 = WM_APP + 2;
/// 边框粗细、顶部提示条高度（物理像素，大致值）
const BORDER: i32 = 4;
const BANNER: i32 = 30;

static THREAD: AtomicU32 = AtomicU32::new(0);
static STARTED: AtomicBool = AtomicBool::new(false);
static OVERLAY: AtomicIsize = AtomicIsize::new(0);

/// 起提示线程（只起一次）
pub fn start() {
    if STARTED.swap(true, Ordering::SeqCst) {
        return;
    }
    std::thread::Builder::new()
        .name("overlay".into())
        .spawn(|| unsafe {
            THREAD.store(GetCurrentThreadId(), Ordering::SeqCst);
            let Some(hwnd) = create() else {
                super::system::log("提示窗口创建失败，屏幕提示不显示");
                return;
            };
            OVERLAY.store(hwnd.0 as isize, Ordering::SeqCst);
            let _ = SetTimer(Some(hwnd), 1, 250, None);
            let mut msg = MSG::default();
            while GetMessageW(&mut msg, None, 0, 0).as_bool() {
                if msg.hwnd.is_invalid() && msg.message == WM_WAKE {
                    update();
                }
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
        })
        .ok();
}

/// activity 变化时催一次即时刷新（任何线程都能调；没起线程就什么都不做）
pub fn wake() {
    let thread = THREAD.load(Ordering::SeqCst);
    if thread != 0 {
        unsafe {
            let _ = PostThreadMessageW(thread, WM_WAKE, WPARAM(0), LPARAM(0));
        }
    }
}

unsafe extern "system" fn wndproc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    match msg {
        WM_TIMER => {
            update();
            LRESULT(0)
        }
        WM_DESTROY => {
            PostQuitMessage(0);
            LRESULT(0)
        }
        _ => DefWindowProcW(hwnd, msg, wparam, lparam),
    }
}

unsafe fn create() -> Option<HWND> {
    let instance = GetModuleHandleW(None).ok()?;
    let class = w!("LitchComputerUseOverlay");
    let wc = WNDCLASSW {
        lpfnWndProc: Some(wndproc),
        hInstance: instance.into(),
        lpszClassName: class,
        ..Default::default()
    };
    RegisterClassW(&wc);
    let hwnd = CreateWindowExW(
        WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE | WS_EX_TOPMOST,
        class,
        w!("Litch"),
        WS_POPUP,
        0,
        0,
        0,
        0,
        None,
        None,
        Some(instance.into()),
        None,
    )
    .ok()?;
    Some(hwnd)
}

/// 复看 activity：该显示就沿目标窗口画，不该显示就藏起来
fn update() {
    let raw = OVERLAY.load(Ordering::SeqCst);
    if raw == 0 {
        return;
    }
    let hwnd = HWND(raw as *mut _);
    match activity::overlay_target() {
        Some((target, text)) if apps::is_alive(apps::hwnd(target)) => {
            let bounds = apps::bounds(apps::hwnd(target));
            if bounds.is_empty() {
                hide(hwnd);
                return;
            }
            draw(hwnd, &bounds, &text);
        }
        _ => hide(hwnd),
    }
}

fn hide(hwnd: HWND) {
    unsafe {
        let _ = ShowWindow(hwnd, SW_HIDE);
    }
}

/// 一个 BGRA 像素（预乘：这里画的都是不透明的，颜色不变）
fn put(buf: &mut [u8], w: i32, x: i32, y: i32, b: u8, g: u8, r: u8) {
    if x < 0 || y < 0 || x >= w {
        return;
    }
    let i = ((y * w + x) * 4) as usize;
    if i + 3 < buf.len() {
        buf[i] = b;
        buf[i + 1] = g;
        buf[i + 2] = r;
        buf[i + 3] = 255;
    }
}

fn draw(hwnd: HWND, bounds: &Rect, text: &str) {
    let w = bounds.width().clamp(1, 6000);
    let wh = bounds.height().clamp(1, 6000);
    let banner_h = BANNER;
    // 窗口上方有空间就把提示条画到窗口外、紧贴上沿（不挡标签页、标题按钮）；否则退回画在顶部内侧
    let above = bounds.top >= banner_h;
    let dib_h = if above { (wh + banner_h).min(6000) } else { wh };
    let frame_top = if above { banner_h } else { 0 };
    let origin_y = if above { bounds.top - banner_h } else { bounds.top };
    // 提示条区域（上方时整条窗口宽；内侧时避开边框）
    let (bx0, by0, bx1, by1) = if above {
        (0, 0, w, banner_h)
    } else {
        let bh = banner_h.min(wh - 2 * BORDER).max(0);
        (BORDER, BORDER, w - BORDER, BORDER + bh)
    };
    let banner_px = by1 - by0;
    unsafe {
        let mut info = BITMAPINFO::default();
        info.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
        info.bmiHeader.biWidth = w;
        info.bmiHeader.biHeight = -dib_h; // 顶向下
        info.bmiHeader.biPlanes = 1;
        info.bmiHeader.biBitCount = 32;
        let mut bits: *mut core::ffi::c_void = std::ptr::null_mut();
        let Ok(bitmap) = CreateDIBSection(None, &info, DIB_RGB_COLORS, &mut bits, None, 0) else {
            return;
        };
        let buf = std::slice::from_raw_parts_mut(bits as *mut u8, (w * dib_h * 4) as usize);
        buf.fill(0); // 全透明

        // 边框：Litch 橙，画在窗口那一块（frame_top 起、高 wh）
        for t in 0..BORDER {
            for x in 0..w {
                put(buf, w, x, frame_top + t, 0, 120, 255);
                put(buf, w, x, frame_top + wh - 1 - t, 0, 120, 255);
            }
            for y in frame_top..(frame_top + wh) {
                put(buf, w, t, y, 0, 120, 255);
                put(buf, w, w - 1 - t, y, 0, 120, 255);
            }
        }
        // 提示条底色（深色，不透明）
        for y in by0..by1 {
            for x in bx0..bx1 {
                put(buf, w, x, y, 22, 20, 20);
            }
        }

        let dc = CreateCompatibleDC(None);
        let old = SelectObject(dc, bitmap.into());
        // 提示条上的文字
        if banner_px >= 14 {
            let font = CreateFontW(
                (banner_px - 12).max(8),
                0,
                0,
                0,
                400,
                0,
                0,
                0,
                FONT_CHARSET(1),
                FONT_OUTPUT_PRECISION(0),
                FONT_CLIP_PRECISION(0),
                FONT_QUALITY(0),
                0,
                w!("Segoe UI"),
            );
            let old_font = SelectObject(dc, font.into());
            SetBkMode(dc, TRANSPARENT);
            SetTextColor(dc, COLORREF(0x00FFFFFF));
            let mut rect = windows::Win32::Foundation::RECT { left: bx0, top: by0, right: bx1, bottom: by1 };
            let mut chars: Vec<u16> = text.encode_utf16().collect();
            DrawTextW(dc, &mut chars, &mut rect, DT_CENTER | DT_VCENTER | DT_SINGLELINE | DT_END_ELLIPSIS);
            // GDI 把文字像素的 alpha 清成了 0，提示条整条强行设回不透明（底色和文字都该实心）
            for y in by0..by1 {
                for x in bx0..bx1 {
                    let i = ((y * w + x) * 4 + 3) as usize;
                    if i < buf.len() {
                        buf[i] = 255;
                    }
                }
            }
            SelectObject(dc, old_font);
            let _ = DeleteObject(font.into());
        }
        // UpdateLayeredWindow 读的是当前选进 dc 的那张位图，必须在把位图换出去之前贴
        blit(hwnd, bounds.left, origin_y, w, dib_h, dc);
        SelectObject(dc, old);
        let _ = DeleteDC(dc);
        let _ = DeleteObject(bitmap.into());
    }
}

unsafe fn blit(hwnd: HWND, x: i32, y: i32, w: i32, h: i32, dc: HDC) {
    if let Err(e) = SetWindowPos(hwnd, Some(HWND_TOPMOST), x, y, w, h, SWP_NOACTIVATE | SWP_SHOWWINDOW) {
        super::system::log(format!("提示窗口 SetWindowPos 失败：{e}（GetLastError {:?}）", GetLastError()));
    }
    let dst = POINT { x, y };
    let size = SIZE { cx: w, cy: h };
    let src = POINT { x: 0, y: 0 };
    let blend = BLENDFUNCTION { BlendOp: AC_SRC_OVER as u8, BlendFlags: 0, SourceConstantAlpha: 255, AlphaFormat: AC_SRC_ALPHA as u8 };
    if let Err(e) = UpdateLayeredWindow(hwnd, None, Some(&dst), Some(&size), Some(dc), Some(&src), COLORREF(0), Some(&blend), ULW_ALPHA) {
        super::system::log(format!("提示窗口 UpdateLayeredWindow 失败：{e}（GetLastError {:?}）", GetLastError()));
    }
}
