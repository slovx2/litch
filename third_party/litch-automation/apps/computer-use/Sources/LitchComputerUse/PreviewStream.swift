// 单窗口 SCStream，采集/编码与输入分离。最多一帧在途，未确认时直接丢新帧，不累积视频队列。
import AppKit
import CoreImage
import CoreMedia
import LitchComputerUseCore
import ScreenCaptureKit

final class PreviewStream: NSObject, SCStreamOutput, SCStreamDelegate {
  private let queue = DispatchQueue(label: "litch.preview.encode", qos: .utility)
  private let lock = NSLock()
  private var stream: SCStream?
  private var stopped = false
  private var inFlight: Int?
  private var sentAt: TimeInterval = 0
  private var lastAt: TimeInterval = 0
  private var seq = 0
  private var receivedFrame = false
  private var attempt = UUID()
  private let context = CIContext(options: [.cacheIntermediates: false])
  let window: NativeWindow
  let onFrame: (Data, Int, Int, Int) -> Void
  let onError: (String) -> Void

  init(window: NativeWindow, onFrame: @escaping (Data, Int, Int, Int) -> Void, onError: @escaping (String) -> Void) {
    self.window = window; self.onFrame = onFrame; self.onError = onError
  }

  func start() {
    attempt = CaptureAccess.begin()
    watchAcknowledgement()
    queue.asyncAfter(deadline: .now() + 8) { [weak self] in
      guard let self, !self.lock.withLock({ self.stopped || self.receivedFrame }) else { return }
      self.fail("capturePending", captureState: "pending")
    }
    Task {
      do {
        let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
        guard let target = content.windows.first(where: { $0.windowID == window.id && $0.owningApplication?.processID == window.pid }) else {
          throw RPCError(.notFound, "Preview window is not visible.")
        }
        let filter = SCContentFilter(desktopIndependentWindow: target)
        let config = SCStreamConfiguration()
        let scale = min(Double(filter.pointPixelScale), 1280 / max(window.frame.width, window.frame.height))
        config.width = max(1, Int(window.frame.width * scale))
        config.height = max(1, Int(window.frame.height * scale))
        config.minimumFrameInterval = CMTime(value: 1, timescale: 10)
        config.queueDepth = 3
        config.showsCursor = false
        config.ignoreShadowsSingleWindow = true
        let capture = SCStream(filter: filter, configuration: config, delegate: self)
        try capture.addStreamOutput(self, type: .screen, sampleHandlerQueue: queue)
        let cancelled = lock.withLock { if !stopped { stream = capture }; return stopped }
        if cancelled { return }
        try await capture.startCapture()
        let ended = lock.withLock { stopped }
        if ended { try? await capture.stopCapture() }
      } catch {
        let failure = CaptureAccess.error(error)
        fail(failure.kind.rawValue, captureState: failure.kind == .captureDenied ? "denied" : "failed")
      }
    }
  }

  private func watchAcknowledgement() {
    queue.asyncAfter(deadline: .now() + 0.5) { [weak self] in
      guard let self else { return }
      let state = self.lock.withLock {
        (self.stopped, self.inFlight != nil && ProcessInfo.processInfo.systemUptime - self.sentAt > 2)
      }
      if state.0 { return }
      if state.1 { self.fail("interrupted"); return }
      self.watchAcknowledgement()
    }
  }

  func ack(_ sequence: Int) {
    lock.lock(); if inFlight == sequence { inFlight = nil }; lock.unlock()
  }

  func stop() {
    lock.lock(); stopped = true; let old = stream; stream = nil; lock.unlock()
    if let old { Task { try? await old.stopCapture() } }
  }

  // 主动隐藏/取消后的异步回调不能把新订阅或权限状态改回错误。
  private func fail(_ reason: String, captureState: String? = nil) {
    lock.lock()
    guard !stopped else { lock.unlock(); return }
    stopped = true; let old = stream; stream = nil
    lock.unlock()
    if let captureState { CaptureAccess.finish(attempt, captureState) }
    if let old { Task { try? await old.stopCapture() } }
    onError(reason)
  }

  func stream(_ stream: SCStream, didStopWithError error: Error) {
    let failure = CaptureAccess.error(error)
    fail(failure.kind.rawValue, captureState: failure.kind == .captureDenied ? "denied" : "failed")
  }

  func stream(_ stream: SCStream, didOutputSampleBuffer buffer: CMSampleBuffer, of type: SCStreamOutputType) {
    guard type == .screen, buffer.isValid,
      let attachment = CMSampleBufferGetSampleAttachmentsArray(buffer, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
      attachment.first?[.status] as? Int == SCFrameStatus.complete.rawValue,
      let pixels = CMSampleBufferGetImageBuffer(buffer) else { return }
    let now = ProcessInfo.processInfo.systemUptime
    lock.lock()
    // 超时后仍不继续堆积；由订阅端重建，旧帧不得确认新流。
    let blocked = stopped || inFlight != nil || now - lastAt < 0.09
    if !blocked { lastAt = now }
    let timeout = inFlight != nil && now - sentAt > 2
    lock.unlock()
    if timeout { fail("interrupted"); return }
    if blocked { return }
    guard (try? window.validate()) != nil else { fail("interrupted"); return }
    let image = CIImage(cvPixelBuffer: pixels)
    guard var cg = context.createCGImage(image, from: image.extent),
      var data = Capture.jpeg(cg, quality: 0.7) else { fail("captureFailed", captureState: "failed"); return }
    if data.count > 384 * 1024 {
      let smaller = image.transformed(by: CGAffineTransform(scaleX: 0.5, y: 0.5))
      guard let reduced = context.createCGImage(smaller, from: smaller.extent),
        let encoded = Capture.jpeg(reduced, quality: 0.65), encoded.count <= 384 * 1024 else {
        fail("captureFailed", captureState: "failed"); return
      }
      cg = reduced; data = encoded
    }
    lock.lock()
    guard !stopped else { lock.unlock(); return }
    receivedFrame = true
    seq += 1; let sequence = seq; inFlight = sequence; sentAt = now
    lock.unlock()
    CaptureAccess.finish(attempt, "ready")
    onFrame(data, cg.width, cg.height, sequence)
  }
}
