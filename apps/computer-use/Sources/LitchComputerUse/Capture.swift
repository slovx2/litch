// 用 ScreenCaptureKit 截目标应用的一个窗口（不是整屏），最长边按 Geometry 的上限缩，编成 JPEG。
// 截的是窗口自己的内容：被别的窗口挡住也截得到，屏幕提示不会出现在截图里。
import CoreGraphics
import Foundation
import ImageIO
import LitchComputerUseCore
import ScreenCaptureKit
import UniformTypeIdentifiers

struct Screenshot {
  var data: Data
  var mime: String
  /// 截图的像素大小（模型看到的坐标系）
  var size: Size
  /// 截图里画的那个窗口在屏幕上的位置和大小（点）
  var windowFrame: Rect
}

enum Capture {
  static let jpegQuality = 0.85

  /// 截 pid 的一个窗口：在它屏幕上的普通窗口里挑和 axFrame 最接近的那个
  static func window(pid: pid_t, axFrame: Rect) throws -> Screenshot {
    let semaphore = DispatchSemaphore(value: 0)
    var outcome: Result<Screenshot, Error> = .failure(RPCError(.failed, "capture timed out"))
    Task.detached {
      do {
        outcome = .success(try await capture(pid: pid, axFrame: axFrame))
      } catch {
        outcome = .failure(error)
      }
      semaphore.signal()
    }
    if semaphore.wait(timeout: .now() + 10) == .timedOut {
      throw RPCError(.failed, "Taking the screenshot timed out. Try again.")
    }
    return try outcome.get()
  }

  private static func capture(pid: pid_t, axFrame: Rect) async throws -> Screenshot {
    let content: SCShareableContent
    do {
      content = try await SCShareableContent.excludingDesktopWindows(
        true, onScreenWindowsOnly: true)
    } catch {
      throw RPCError(.permission, "Screen Recording")
    }
    let candidates = content.windows.filter {
      $0.owningApplication?.processID == pid && $0.windowLayer == 0 && $0.frame.width > 1
        && $0.frame.height > 1
    }
    let target = candidates.min { distance($0.frame, axFrame) < distance($1.frame, axFrame) }
    guard let target else {
      throw RPCError(
        .notFound,
        "The app's window is not on screen (minimized, hidden or on another Space). Ask the user to show it."
      )
    }
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
      data: data, mime: "image/jpeg",
      size: Size(width: Double(image.width), height: Double(image.height)),
      windowFrame: Rect(
        x: Double(frame.origin.x), y: Double(frame.origin.y), width: Double(frame.width),
        height: Double(frame.height)))
  }

  private static func distance(_ frame: CGRect, _ target: Rect) -> Double {
    abs(Double(frame.origin.x) - target.origin.x) + abs(Double(frame.origin.y) - target.origin.y)
      + abs(Double(frame.width) - target.size.width) + abs(Double(frame.height) - target.size.height)
  }

  static func jpeg(_ image: CGImage) -> Data? {
    let data = NSMutableData()
    guard
      let destination = CGImageDestinationCreateWithData(
        data, UTType.jpeg.identifier as CFString, 1, nil)
    else { return nil }
    CGImageDestinationAddImage(
      destination, image, [kCGImageDestinationLossyCompressionQuality: jpegQuality] as CFDictionary)
    guard CGImageDestinationFinalize(destination) else { return nil }
    return data as Data
  }
}
