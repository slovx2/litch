// 屏幕提示：一个置顶、点击穿透、不抢焦点的分层窗口，沿目标窗口画一圈橙色边框，并在窗口上沿外面
// （没空间时退回窗口内侧顶部）画一块水平居中、Litch 橙底、深色粗字的提示标签。
// 内容、要不要显示、跟着哪个窗口都来自 activity::overlay_target()；尺寸按目标窗口所在显示器的 DPI 放大。
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
use windows::Win32::UI::HiDpi::GetDpiForWindow;
use windows::Win32::UI::WindowsAndMessaging::*;

const WM_WAKE: u32 = WM_APP + 2;
/// 100% 缩放下的基准尺寸（物理像素；实际按目标窗口所在显示器的 DPI 放大）
const BORDER_BASE: f32 = 4.0; // 边框粗细
const TAB_H_BASE: f32 = 32.0; // 提示标签高
const FONT_BASE: f32 = 17.0; // 字号
const PAD_BASE: f32 = 12.0; // 标签左右内边距
/// Litch 橙（put 的参数序是 b, g, r）
const ORANGE: (u8, u8, u8) = (0, 120, 255);
/// 标签上的深色文字（COLORREF 是 0x00BBGGRR）
const TAB_TEXT: COLORREF = COLORREF(0x0014_1414);

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
        Some((target, text)) => {
            let th = apps::hwnd(target);
            if !apps::is_alive(th) {
                hide(hwnd);
                return;
            }
            let bounds = apps::bounds(th);
            if bounds.is_empty() {
                hide(hwnd);
                return;
            }
            let dpi = unsafe { GetDpiForWindow(th) };
            draw(hwnd, &bounds, &text, dpi);
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

fn draw(hwnd: HWND, bounds: &Rect, text: &str, dpi: u32) {
    let w = bounds.width().clamp(1, 6000);
    let wh = bounds.height().clamp(1, 6000);
    // 按目标窗口所在显示器的 DPI 放大（96 = 100%）；读不到就当 100%
    let scale = (dpi as f32 / 96.0).clamp(1.0, 4.0);
    let border = ((BORDER_BASE * scale).round() as i32).max(2);
    let tab_h = ((TAB_H_BASE * scale).round() as i32).max(1);
    let font_h = ((FONT_BASE * scale).round() as i32).max(8);
    let pad = ((PAD_BASE * scale).round() as i32).max(4);

    // 窗口上方有空间就把标签画到窗口外、紧贴上沿（不挡标签页、标题按钮）；否则退回画在顶部内侧
    let above = bounds.top >= tab_h;
    let dib_h = if above { (wh + tab_h).min(6000) } else { wh };
    let frame_top = if above { tab_h } else { 0 };
    let origin_y = if above { bounds.top - tab_h } else { bounds.top };
    // 标签竖向范围：上方时占整个 0..tab_h；内侧时在上边框之下
    let (band_y0, band_y1) = if above {
        (0, tab_h)
    } else {
        let y0 = border;
        (y0, (y0 + tab_h).min(wh - border).max(y0))
    };
    let band_h = band_y1 - band_y0;

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
        let (b, g, r) = ORANGE;
        for t in 0..border {
            for x in 0..w {
                put(buf, w, x, frame_top + t, b, g, r);
                put(buf, w, x, frame_top + wh - 1 - t, b, g, r);
            }
            for y in frame_top..(frame_top + wh) {
                put(buf, w, t, y, b, g, r);
                put(buf, w, w - 1 - t, y, b, g, r);
            }
        }

        let dc = CreateCompatibleDC(None);
        let old = SelectObject(dc, bitmap.into());
        // 粗体 Segoe UI，先量出文字宽度，再定标签宽度
        let font = CreateFontW(
            font_h,
            0,
            0,
            0,
            700, // 粗体
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
        let mut chars: Vec<u16> = text.encode_utf16().collect();
        let mut text_size = SIZE::default();
        let _ = GetTextExtentPoint32W(dc, &chars, &mut text_size);
        // 标签：水平居中、不占满整条宽度（文字宽 + 左右内边距，封顶到窗口宽）
        let tab_w = (text_size.cx + 2 * pad).clamp(1, w);
        let tab_x0 = ((w - tab_w) / 2).max(0);
        let tab_x1 = (tab_x0 + tab_w).min(w);

        if band_h >= 10 {
            // 标签底：Litch 橙，实心
            for y in band_y0..band_y1 {
                for x in tab_x0..tab_x1 {
                    put(buf, w, x, y, b, g, r);
                }
            }
            // 深色粗字，居中
            SetBkMode(dc, TRANSPARENT);
            SetTextColor(dc, TAB_TEXT);
            let mut rect = windows::Win32::Foundation::RECT { left: tab_x0, top: band_y0, right: tab_x1, bottom: band_y1 };
            DrawTextW(dc, &mut chars, &mut rect, DT_CENTER | DT_VCENTER | DT_SINGLELINE | DT_END_ELLIPSIS);
            // GDI 把文字像素的 alpha 清成了 0，标签整块强行设回不透明（底色和文字都该实心）
            for y in band_y0..band_y1 {
                for x in tab_x0..tab_x1 {
                    let i = ((y * w + x) * 4 + 3) as usize;
                    if i < buf.len() {
                        buf[i] = 255;
                    }
                }
            }
        }
        SelectObject(dc, old_font);
        let _ = DeleteObject(font.into());
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
