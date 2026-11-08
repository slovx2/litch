// 坐标约定：模型给的坐标一律是“返回给它的那张截图里的像素”。助手记住截图时窗口的大小和截图的大小，
// 动作时按窗口现在的位置换算成屏幕上的点（全局坐标，原点在主屏左上角，和辅助功能、CGEvent 用的一样）。
// Retina 倍率不用单独管：截图的像素数和窗口的点数之比里已经含了倍率和缩放。

public struct Size: Equatable, Sendable {
  public var width: Double
  public var height: Double
  public init(width: Double, height: Double) {
    self.width = width
    self.height = height
  }
}

public struct Point: Equatable, Sendable {
  public var x: Double
  public var y: Double
  public init(x: Double, y: Double) {
    self.x = x
    self.y = y
  }
}

public struct Rect: Equatable, Sendable {
  public var origin: Point
  public var size: Size
  public init(x: Double, y: Double, width: Double, height: Double) {
    origin = Point(x: x, y: y)
    size = Size(width: width, height: height)
  }

  public var center: Point {
    Point(x: origin.x + size.width / 2, y: origin.y + size.height / 2)
  }

  public func contains(_ point: Point) -> Bool {
    point.x >= origin.x && point.y >= origin.y && point.x < origin.x + size.width
      && point.y < origin.y + size.height
  }
}

public enum Geometry {
  /// 截图必须唯一匹配 AX 窗口；不能在目标最小化后改截另一个“最近”的窗口。
  public static func matchingWindowIndex(frames: [Rect], target: Rect) -> Int? {
    let matches = frames.indices.filter { index in
      let frame = frames[index]
      return abs(frame.origin.x - target.origin.x) < 2 && abs(frame.origin.y - target.origin.y) < 2
        && abs(frame.size.width - target.size.width) < 2 && abs(frame.size.height - target.size.height) < 2
    }
    return matches.count == 1 ? matches[0] : nil
  }

  /// 截图最长边的上限（像素）。超过就等比缩小
  public static let maxScreenshotEdge = 1568

  /// 窗口截图要出多大：窗口的点数乘屏幕倍率，最长边不超过上限，至少 1 像素
  public static func screenshotSize(window: Size, backingScale: Double, maxEdge: Int = maxScreenshotEdge)
    -> (width: Int, height: Int)
  {
    let scale = backingScale > 0 ? backingScale : 1
    var width = window.width * scale
    var height = window.height * scale
    let longest = max(width, height)
    if longest > Double(maxEdge) {
      let shrink = Double(maxEdge) / longest
      width *= shrink
      height *= shrink
    }
    return (max(1, Int(width.rounded())), max(1, Int(height.rounded())))
  }

  /// 截图像素 → 屏幕上的点。
  /// - image: 截图的像素大小
  /// - capturedWindow: 截图时窗口的大小（点）
  /// - window: 窗口现在的位置和大小（点）。大小和截图时不一样就说明窗口变了，回 nil，让模型重新取状态
  public static func screenPoint(imagePoint: Point, image: Size, capturedWindow: Size, window: Rect)
    -> Point?
  {
    guard image.width > 0, image.height > 0 else { return nil }
    guard abs(window.size.width - capturedWindow.width) < 1,
      abs(window.size.height - capturedWindow.height) < 1
    else { return nil }
    let x = window.origin.x + imagePoint.x * capturedWindow.width / image.width
    let y = window.origin.y + imagePoint.y * capturedWindow.height / image.height
    return Point(x: x, y: y)
  }

  /// 屏幕上的点 → 截图像素（给模型看元素在截图里的位置时用）
  public static func imagePoint(screenPoint: Point, image: Size, window: Rect) -> Point? {
    guard window.size.width > 0, window.size.height > 0 else { return nil }
    return Point(
      x: (screenPoint.x - window.origin.x) * image.width / window.size.width,
      y: (screenPoint.y - window.origin.y) * image.height / window.size.height)
  }

  /// 坐标在不在截图里
  public static func inside(_ point: Point, image: Size) -> Bool {
    point.x >= 0 && point.y >= 0 && point.x < image.width && point.y < image.height
  }
}
