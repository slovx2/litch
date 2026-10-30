// 用 ScreenCaptureKit 截目标应用的一个窗口（不是整屏），最长边按 Geometry 的上限缩，编成 JPEG。
// 截的是窗口自己的内容：被别的窗口挡住也截得到，屏幕提示不会出现在截图里。
import CoreGraphics
import Foundation
import ImageIO
import LitchComputerUseCore
import ScreenCaptureKit
import UniformTypeIdentifiers

struct Screenshot {
  var windowID: CGWindowID
  var data: Data
  var mime: String
  /// 截图的像素大小（模型看到的坐标系）
  var size: Size
  /// 截图里画的那个窗口在屏幕上的位置和大小（点）
  var windowFrame: Rect
}

enum Capture {
  static let jpegQuality = 0.85
  private static let pendingLock = NSLock()
  private static var pendingCapture = false

  /// 截 pid 的 AX 窗口，位置和大小必须唯一匹配。
  static func window(pid: pid_t, axFrame: Rect) throws -> Screenshot {
    let admitted = pendingLock.withLock {
      if pendingCapture { return false }
      pendingCapture = true; return true
    }
    guard admitted else { throw CaptureAccess.pendingError }
    // 截图接口是异步的，这里在连接的线程上等它（每条连接本来就是一个一个处理请求）
    let box = Outcome()
    let attempt = CaptureAccess.begin()
    let task = Task.detached {
      defer { pendingLock.withLock { pendingCapture = false } }
      do {
        box.set(.success(try await capture(pid: pid, axFrame: axFrame)))
      } catch {
        box.set(.failure(error))
      }
    }
    guard let outcome = box.wait(seconds: 8) else {
      task.cancel()
      CaptureAccess.finish(attempt, "pending")
      throw CaptureAccess.pendingError
    }
    do {
      let shot = try outcome.get()
      CaptureAccess.finish(attempt, "ready")
      return shot
    } catch {
      let failure = CaptureAccess.error(error)
      CaptureAccess.finish(attempt, failure.kind == .captureDenied ? "denied" : "failed")
      throw failure
    }
  }

  /// 跨线程交一次结果
  private final class Outcome: @unchecked Sendable {
    private let lock = NSLock()
    private let done = DispatchSemaphore(value: 0)
    private var value: Result<Screenshot, Error>?

    func set(_ result: Result<Screenshot, Error>) {
      lock.lock()
      value = result
      lock.unlock()
      done.signal()
    }

    func wait(seconds: Double) -> Result<Screenshot, Error>? {
      guard done.wait(timeout: .now() + seconds) == .success else { return nil }
      lock.lock()
      defer { lock.unlock() }
      return value
    }
  }

  private static func capture(pid: pid_t, axFrame: Rect) async throws -> Screenshot {
    let content: SCShareableContent
    do {
      content = try await SCShareableContent.excludingDesktopWindows(
        true, onScreenWindowsOnly: true)
    } catch {
      throw CaptureAccess.error(error)
    }
    let candidates = content.windows.filter {
      $0.owningApplication?.processID == pid && $0.windowLayer == 0 && $0.frame.width > 1
        && $0.frame.height > 1
    }
    let frames = candidates.map { Rect(x: $0.frame.minX, y: $0.frame.minY,
      width: $0.frame.width, height: $0.frame.height) }
    guard let index = Geometry.matchingWindowIndex(frames: frames, target: axFrame) else {
      throw RPCError(
        .stale,
        "The accessibility window has no unique visible screenshot match (it may be minimized, moved or overlapped by an identical window). No other window was captured. Call get_app_state again; if this repeats, ask the user to show the intended window."
      )
    }
    let target = candidates[index]
    let filter = SCContentFilter(desktopIndependentWindow: target)
    let configuration = SCStreamConfiguration()
    let frame = target.frame
    let pixels = Geometry.screenshotSize(
      window: Size(width: Double(frame.width), height: Double(frame.height)),
      backingScale: Double(filter.pointPixelScale))
    configuration.width = pixels.width
    configuration.height = pixels.height
    configuration.showsCursor = false
    configuration.ignoreShadowsSingleWindow = true
    let image = try await SCScreenshotManager.captureImage(
      contentFilter: filter, configuration: configuration)
    guard let data = jpeg(image) else { throw RPCError(.failed, "Could not encode the screenshot.") }
    return Screenshot(
      windowID: target.windowID, data: data, mime: "image/jpeg",
      size: Size(width: Double(image.width), height: Double(image.height)),
      windowFrame: Rect(
        x: Double(frame.origin.x), y: Double(frame.origin.y), width: Double(frame.width),
        height: Double(frame.height)))
  }

  static func jpeg(_ image: CGImage, quality: Double = jpegQuality) -> Data? {
    let data = NSMutableData()
    guard
      let destination = CGImageDestinationCreateWithData(
        data, UTType.jpeg.identifier as CFString, 1, nil)
    else { return nil }
    CGImageDestinationAddImage(
      destination, image, [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary)
    guard CGImageDestinationFinalize(destination) else { return nil }
    return data as Data
  }
}
