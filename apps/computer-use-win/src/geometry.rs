// 坐标换算。助手是每显示器感知 V2，系统接口给的坐标一律是物理像素；
// 给模型和主进程的坐标一律是截图像素（截图左上角为原点，09 号 9.2 节），两者之间只差窗口原点和截图缩放。
use crate::fail;
use crate::wire::RpcResult;
use serde::Serialize;

/// 截图最长边（和 macOS 一致）
pub const MAX_EDGE: u32 = 1568;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Rect {
    pub left: i32,
    pub top: i32,
    pub right: i32,
    pub bottom: i32,
}

impl Rect {
    pub fn new(left: i32, top: i32, right: i32, bottom: i32) -> Rect {
        Rect { left, top, right, bottom }
    }
    pub fn width(&self) -> i32 {
        self.right - self.left
    }
    pub fn height(&self) -> i32 {
        self.bottom - self.top
    }
    pub fn is_empty(&self) -> bool {
        self.width() <= 0 || self.height() <= 0
    }
    pub fn contains(&self, x: i32, y: i32) -> bool {
        x >= self.left && x < self.right && y >= self.top && y < self.bottom
    }
    pub fn intersect(&self, other: &Rect) -> Rect {
        Rect::new(self.left.max(other.left), self.top.max(other.top), self.right.min(other.right), self.bottom.min(other.bottom))
    }
    pub fn center(&self) -> (i32, i32) {
        (self.left + self.width() / 2, self.top + self.height() / 2)
    }
}

/// WinNode 里的 frame（截图像素）
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct Frame {
    pub x: i64,
    pub y: i64,
    pub width: i64,
    pub height: i64,
}

/// 物理尺寸 → 截图缩放（不放大）
pub fn scale_for(width: i32, height: i32) -> f64 {
    let longest = width.max(height).max(1) as f64;
    (MAX_EDGE as f64 / longest).min(1.0)
}

/// 物理尺寸 → 截图尺寸
pub fn shot_size(width: i32, height: i32) -> (u32, u32) {
    let scale = scale_for(width, height);
    (((width.max(1) as f64) * scale).round().max(1.0) as u32, ((height.max(1) as f64) * scale).round().max(1.0) as u32)
}

/// 一张截图和屏幕之间的对应：截图覆盖的屏幕区域（窗口的可见边界）和缩放
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ShotMap {
    pub window: Rect,
    pub scale: f64,
    pub width: u32,
    pub height: u32,
}

impl ShotMap {
    pub fn for_window(window: Rect) -> ShotMap {
        let (width, height) = shot_size(window.width(), window.height());
        ShotMap { window, scale: scale_for(window.width(), window.height()), width, height }
    }

    /// 截图像素 → 屏幕物理像素。出了截图回 invalid
    pub fn to_screen(&self, x: f64, y: f64) -> RpcResult<(i32, i32)> {
        if !x.is_finite() || !y.is_finite() || x < 0.0 || y < 0.0 || x >= self.width as f64 || y >= self.height as f64 {
            return Err(fail!(
                Invalid,
                "point ({x}, {y}) is outside the screenshot ({}x{}); use coordinates from the latest screenshot",
                self.width,
                self.height
            ));
        }
        let sx = self.window.left + (x / self.scale).floor() as i32;
        let sy = self.window.top + (y / self.scale).floor() as i32;
        Ok((sx.min(self.window.right - 1), sy.min(self.window.bottom - 1)))
    }

    /// 屏幕上的矩形 → 截图像素里的 frame（只取和窗口相交的部分；不相交回 None）
    pub fn to_frame(&self, rect: &Rect) -> Option<Frame> {
        let visible = rect.intersect(&self.window);
        if visible.is_empty() {
            return None;
        }
        let x = ((visible.left - self.window.left) as f64 * self.scale).round() as i64;
        let y = ((visible.top - self.window.top) as f64 * self.scale).round() as i64;
        let right = ((visible.right - self.window.left) as f64 * self.scale).round() as i64;
        let bottom = ((visible.bottom - self.window.top) as f64 * self.scale).round() as i64;
        Some(Frame { x, y, width: (right - x).max(1), height: (bottom - y).max(1) })
    }
}

/// SendInput 绝对坐标：虚拟桌面上的物理像素 → 0..65535
pub fn absolute(x: i32, y: i32, desktop: &Rect) -> (i32, i32) {
    let span = |offset: i32, size: i32| -> i32 {
        if size <= 1 {
            return 0;
        }
        (((offset as i64) * 65535 + (size as i64 - 1) / 2) / (size as i64 - 1)).clamp(0, 65535) as i32
    };
    (span(x - desktop.left, desktop.width()), span(y - desktop.top, desktop.height()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scales_only_down() {
        assert_eq!(shot_size(800, 600), (800, 600));
        assert_eq!(shot_size(3136, 1000), (1568, 500));
        assert_eq!(shot_size(1000, 3136), (500, 1568));
        assert_eq!(scale_for(100, 100), 1.0);
    }

    #[test]
    fn maps_points() {
        let map = ShotMap::for_window(Rect::new(100, 50, 100 + 3136, 50 + 2000));
        assert_eq!((map.width, map.height), (1568, 1000));
        assert_eq!(map.to_screen(0.0, 0.0).unwrap(), (100, 50));
        assert_eq!(map.to_screen(10.0, 20.0).unwrap(), (120, 90));
        assert_eq!(map.to_screen(1567.9, 999.9).unwrap(), (100 + 3135, 50 + 1999));
        assert!(map.to_screen(1568.0, 0.0).is_err());
        assert!(map.to_screen(-1.0, 0.0).is_err());
        assert!(map.to_screen(f64::NAN, 0.0).is_err());
    }

    #[test]
    fn maps_frames() {
        let map = ShotMap::for_window(Rect::new(-50, 0, 3086, 2000));
        let frame = map.to_frame(&Rect::new(-50, 0, 150, 100)).unwrap();
        assert_eq!(frame, Frame { x: 0, y: 0, width: 100, height: 50 });
        // 伸出窗口的部分裁掉
        let clipped = map.to_frame(&Rect::new(-500, -500, 0, 10)).unwrap();
        assert_eq!(clipped, Frame { x: 0, y: 0, width: 25, height: 5 });
        assert_eq!(map.to_frame(&Rect::new(5000, 0, 5100, 10)), None);
        assert_eq!(map.to_frame(&Rect::new(0, 0, 0, 10)), None);
    }

    #[test]
    fn absolute_coordinates() {
        let desktop = Rect::new(-1920, 0, 3840, 2160);
        assert_eq!(absolute(-1920, 0, &desktop), (0, 0));
        assert_eq!(absolute(3839, 2159, &desktop), (65535, 65535));
        let (x, _) = absolute(0, 0, &desktop);
        assert!((x - 21849).abs() <= 1, "{x}");
    }

    #[test]
    fn rect_helpers() {
        let r = Rect::new(0, 0, 10, 20);
        assert!(r.contains(0, 0) && r.contains(9, 19) && !r.contains(10, 5));
        assert_eq!(r.center(), (5, 10));
        assert!(Rect::new(5, 5, 5, 9).is_empty());
    }
}
