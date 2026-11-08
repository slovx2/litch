// 截窗口：Windows.Graphics.Capture 的 CreateForWindow，被挡住也截得到；系统支持时关掉黄框。
// 不支持或失败时退回 PrintWindow(PW_RENDERFULLCONTENT)。同一进程盖在上面的菜单、下拉框按屏幕位置叠进同一张图。
// 最后缩到最长边 1568、编成 JPEG（WIC）。
use super::apps;
use super::system::log;
use crate::geometry::{Rect, ShotMap};
use std::cell::RefCell;
use std::time::{Duration, Instant};
use windows::core::{Interface, Result, HSTRING};
use windows::Foundation::Metadata::ApiInformation;
use windows::Graphics::Capture::{Direct3D11CaptureFramePool, GraphicsCaptureItem, GraphicsCaptureSession};
use windows::Graphics::DirectX::Direct3D11::IDirect3DDevice;
use windows::Graphics::DirectX::DirectXPixelFormat;
use windows::Win32::Foundation::{E_FAIL, HMODULE, HWND};
use windows::Win32::Graphics::Direct3D::D3D_DRIVER_TYPE_HARDWARE;
use windows::Win32::Graphics::Direct3D11::*;
use windows::Win32::Graphics::Dxgi::IDXGIDevice;
use windows::Win32::Graphics::Gdi::*;
use windows::Win32::Graphics::Imaging::*;
use windows::Win32::Storage::Xps::{PrintWindow, PRINT_WINDOW_FLAGS};
use windows::Win32::System::Com::StructuredStorage::{CreateStreamOnHGlobal, IPropertyBag2, PROPBAG2};
use windows::Win32::System::Com::*;
use windows::Win32::System::Variant::VARIANT;
use windows::Win32::System::WinRT::Direct3D11::{CreateDirect3D11DeviceFromDXGIDevice, IDirect3DDxgiInterfaceAccess};
use windows::Win32::System::WinRT::Graphics::Capture::IGraphicsCaptureItemInterop;
use windows::Win32::UI::WindowsAndMessaging::GetWindowRect;

/// 一张 BGRA 的图（物理像素）
pub struct Image {
    pub width: u32,
    pub height: u32,
    pub bgra: Vec<u8>,
}

struct Gpu {
    device: ID3D11Device,
    context: ID3D11DeviceContext,
    winrt: IDirect3DDevice,
}

thread_local! {
    static GPU: RefCell<Option<Gpu>> = const { RefCell::new(None) };
}

fn make_gpu() -> Result<Gpu> {
    unsafe {
        let mut device = None;
        let mut context = None;
        D3D11CreateDevice(
            None,
            D3D_DRIVER_TYPE_HARDWARE,
            HMODULE::default(),
            D3D11_CREATE_DEVICE_BGRA_SUPPORT,
            None,
            D3D11_SDK_VERSION,
            Some(&mut device),
            None,
            Some(&mut context),
        )?;
        let device: ID3D11Device = device.ok_or_else(|| windows::core::Error::new(E_FAIL, "no d3d device"))?;
        let context = context.ok_or_else(|| windows::core::Error::new(E_FAIL, "no d3d context"))?;
        let dxgi: IDXGIDevice = device.cast()?;
        let winrt: IDirect3DDevice = CreateDirect3D11DeviceFromDXGIDevice(&dxgi)?.cast()?;
        Ok(Gpu { device, context, winrt })
    }
}

/// 这台系统能不能用 WGC
pub fn wgc_supported() -> bool {
    GraphicsCaptureSession::IsSupported().unwrap_or(false)
}

/// 这台系统能不能关掉截图时的黄框（GraphicsCaptureSession.IsBorderRequired，Windows 11 起有）
pub fn borderless_supported() -> bool {
    ApiInformation::IsPropertyPresent(
        &HSTRING::from("Windows.Graphics.Capture.GraphicsCaptureSession"),
        &HSTRING::from("IsBorderRequired"),
    )
    .unwrap_or(false)
}

fn wgc_frame(gpu: &Gpu, h: HWND) -> Result<Image> {
    let interop = windows::core::factory::<GraphicsCaptureItem, IGraphicsCaptureItemInterop>()?;
    let item: GraphicsCaptureItem = unsafe { interop.CreateForWindow(h)? };
    let size = item.Size()?;
    let pool = Direct3D11CaptureFramePool::CreateFreeThreaded(&gpu.winrt, DirectXPixelFormat::B8G8R8A8UIntNormalized, 1, size)?;
    let session = pool.CreateCaptureSession(&item)?;
    if borderless_supported() {
        let _ = session.SetIsBorderRequired(false);
    }
    let _ = session.SetIsCursorCaptureEnabled(false);
    session.StartCapture()?;
    let started = Instant::now();
    let frame = loop {
        if let Ok(frame) = pool.TryGetNextFrame() {
            break frame;
        }
        if started.elapsed() > Duration::from_secs(2) {
            let _ = session.Close();
            let _ = pool.Close();
            return Err(windows::core::Error::new(E_FAIL, "no frame from Windows.Graphics.Capture in 2 s"));
        }
        std::thread::sleep(Duration::from_millis(5));
    };
    let access: IDirect3DDxgiInterfaceAccess = frame.Surface()?.cast()?;
    let image = unsafe {
        let texture: ID3D11Texture2D = access.GetInterface()?;
        let mut desc = D3D11_TEXTURE2D_DESC::default();
        texture.GetDesc(&mut desc);
        desc.Usage = D3D11_USAGE_STAGING;
        desc.BindFlags = 0;
        desc.CPUAccessFlags = D3D11_CPU_ACCESS_READ.0 as u32;
        desc.MiscFlags = 0;
        let mut staging = None;
        gpu.device.CreateTexture2D(&desc, None, Some(&mut staging))?;
        let staging = staging.ok_or_else(|| windows::core::Error::new(E_FAIL, "no staging texture"))?;
        gpu.context.CopyResource(&staging, &texture);
        let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
        gpu.context.Map(&staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped))?;
        let (w, h) = (desc.Width, desc.Height);
        let mut bgra = vec![0u8; (w * h * 4) as usize];
        for row in 0..h {
            let src = (mapped.pData as *const u8).add((row * mapped.RowPitch) as usize);
            std::ptr::copy_nonoverlapping(src, bgra.as_mut_ptr().add((row * w * 4) as usize), (w * 4) as usize);
        }
        gpu.context.Unmap(&staging, 0);
        Image { width: w, height: h, bgra }
    };
    let _ = frame.Close();
    let _ = session.Close();
    let _ = pool.Close();
    Ok(image)
}

fn wgc(h: HWND) -> Result<Image> {
    GPU.with(|cell| {
        let mut slot = cell.borrow_mut();
        if slot.is_none() {
            *slot = Some(make_gpu()?);
        }
        let result = wgc_frame(slot.as_ref().expect("gpu"), h);
        if result.is_err() {
            // 设备可能丢了（显卡驱动重置等），下次重建
            *slot = None;
        }
        result
    })
}

/// PrintWindow 的退路：画整个窗口矩形，再裁到可见边界
fn print_window(h: HWND, visible: &Rect) -> Option<Image> {
    unsafe {
        let mut r = windows::Win32::Foundation::RECT::default();
        GetWindowRect(h, &mut r).ok()?;
        let (w, ht) = (r.right - r.left, r.bottom - r.top);
        if w <= 0 || ht <= 0 {
            return None;
        }
        let screen = GetDC(None);
        let mem = CreateCompatibleDC(Some(screen));
        let bitmap = CreateCompatibleBitmap(screen, w, ht);
        let old = SelectObject(mem, bitmap.into());
        // PW_RENDERFULLCONTENT = 2
        let ok = PrintWindow(h, mem, PRINT_WINDOW_FLAGS(2)).as_bool();
        let mut info = BITMAPINFO::default();
        info.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
        info.bmiHeader.biWidth = w;
        info.bmiHeader.biHeight = -ht;
        info.bmiHeader.biPlanes = 1;
        info.bmiHeader.biBitCount = 32;
        let mut full = vec![0u8; (w * ht * 4) as usize];
        GetDIBits(mem, bitmap, 0, ht as u32, Some(full.as_mut_ptr() as *mut _), &mut info, DIB_RGB_COLORS);
        SelectObject(mem, old);
        let _ = DeleteObject(bitmap.into());
        let _ = DeleteDC(mem);
        ReleaseDC(None, screen);
        if !ok {
            return None;
        }
        let ox = (visible.left - r.left).clamp(0, w);
        let oy = (visible.top - r.top).clamp(0, ht);
        let cw = visible.width().min(w - ox).max(1);
        let ch = visible.height().min(ht - oy).max(1);
        let mut bgra = vec![0u8; (cw * ch * 4) as usize];
        for row in 0..ch {
            let src = (((oy + row) * w + ox) * 4) as usize;
            let dst = (row * cw * 4) as usize;
            bgra[dst..dst + (cw * 4) as usize].copy_from_slice(&full[src..src + (cw * 4) as usize]);
        }
        for px in bgra.chunks_mut(4) {
            px[3] = 255;
        }
        Some(Image { width: cw as u32, height: ch as u32, bgra })
    }
}

/// 把弹出层的图按屏幕位置贴进底图
fn paste(base: &mut Image, base_origin: (i32, i32), layer: &Image, layer_origin: (i32, i32)) {
    let dx = layer_origin.0 - base_origin.0;
    let dy = layer_origin.1 - base_origin.1;
    for row in 0..layer.height as i32 {
        let y = dy + row;
        if y < 0 || y >= base.height as i32 {
            continue;
        }
        let x0 = dx.max(0);
        let x1 = (dx + layer.width as i32).min(base.width as i32);
        if x1 <= x0 {
            continue;
        }
        let src = ((row * layer.width as i32 + (x0 - dx)) * 4) as usize;
        let dst = ((y * base.width as i32 + x0) * 4) as usize;
        let len = ((x1 - x0) * 4) as usize;
        base.bgra[dst..dst + len].copy_from_slice(&layer.bgra[src..src + len]);
    }
}

/// 截一个窗口（含同进程的弹出层）。回图和它覆盖的屏幕区域
pub fn window(h: HWND, pid: u32, notes: &mut Vec<String>) -> Option<(Image, Rect)> {
    let visible = apps::bounds(h);
    let image = match wgc(h) {
        Ok(image) => Some(image),
        Err(error) => {
            log(format!("WGC 截图失败（{error}），改用 PrintWindow"));
            notes.push("Screenshot taken with PrintWindow; some content (video, GPU surfaces) may be missing.".into());
            print_window(h, &visible)
        }
    }?;
    // WGC 的图和可见边界一般一样大；对不上时以图为准，从可见边界的左上角起算
    let area = Rect::new(visible.left, visible.top, visible.left + image.width as i32, visible.top + image.height as i32);
    let mut image = image;
    // 只贴目标进程（pid）自己的弹出层（菜单、下拉、提示）。助手的提示窗口属于助手进程，这里天然不会被贴进来，
    // 所以提示窗口不需要 WDA_EXCLUDEFROMCAPTURE 也进不了我们的截图。
    for popup in apps::popups(h, pid) {
        let popup_area = apps::bounds(popup);
        if popup_area.intersect(&area).is_empty() {
            continue;
        }
        if let Ok(layer) = wgc(popup) {
            paste(&mut image, (area.left, area.top), &layer, (popup_area.left, popup_area.top));
        }
    }
    Some((image, area))
}

/// JPEG 质量
const QUALITY: f32 = 0.8;

/// 缩放到截图尺寸并编成 JPEG
pub fn jpeg(image: &Image, map: &ShotMap) -> Result<Vec<u8>> {
    unsafe {
        let factory: IWICImagingFactory = CoCreateInstance(&CLSID_WICImagingFactory, None, CLSCTX_INPROC_SERVER)?;
        let bitmap =
            factory.CreateBitmapFromMemory(image.width, image.height, &GUID_WICPixelFormat32bppBGRA, image.width * 4, &image.bgra)?;
        let scaler = factory.CreateBitmapScaler()?;
        scaler.Initialize(&bitmap, map.width, map.height, WICBitmapInterpolationModeFant)?;
        let converter = factory.CreateFormatConverter()?;
        converter.Initialize(&scaler, &GUID_WICPixelFormat24bppBGR, WICBitmapDitherTypeNone, None, 0.0, WICBitmapPaletteTypeCustom)?;
        let stream = CreateStreamOnHGlobal(Default::default(), true)?;
        let encoder = factory.CreateEncoder(&GUID_ContainerFormatJpeg, std::ptr::null())?;
        encoder.Initialize(&stream, WICBitmapEncoderNoCache)?;
        let mut frame = None;
        let mut props: Option<IPropertyBag2> = None;
        encoder.CreateNewFrame(&mut frame, &mut props)?;
        let frame = frame.ok_or_else(|| windows::core::Error::new(E_FAIL, "no jpeg frame"))?;
        if let Some(bag) = props.as_ref() {
            let name = HSTRING::from("ImageQuality");
            let option = PROPBAG2 { pstrName: windows::core::PWSTR(name.as_ptr() as *mut u16), ..Default::default() };
            let value = VARIANT::from(QUALITY);
            let _ = bag.Write(1, &option, &value);
        }
        frame.Initialize(props.as_ref())?;
        frame.SetSize(map.width, map.height)?;
        let mut format = GUID_WICPixelFormat24bppBGR;
        frame.SetPixelFormat(&mut format)?;
        frame.WriteSource(&converter, std::ptr::null())?;
        frame.Commit()?;
        encoder.Commit()?;
        let mut stat = STATSTG::default();
        stream.Stat(&mut stat, STATFLAG_NONAME)?;
        stream.Seek(0, STREAM_SEEK_SET, None)?;
        let mut out = vec![0u8; stat.cbSize as usize];
        let mut read = 0u32;
        stream.Read(out.as_mut_ptr() as *mut _, out.len() as u32, Some(&mut read)).ok()?;
        out.truncate(read as usize);
        Ok(out)
    }
}
