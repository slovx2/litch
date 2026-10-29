// 系统预检不是实采成功证明。只在收到真实截图/视频帧后记 ready；拒绝与等待分开报告。
import Foundation
import LitchComputerUseCore
import ScreenCaptureKit

enum CaptureAccess {
  private static let lock = NSLock()
  private static var state = "untested"
  private static var attempt = UUID()
  static var status: String { lock.withLock { state } }
  static func begin() -> UUID {
    lock.withLock { attempt = UUID(); state = "pending"; return attempt }
  }
  static func finish(_ token: UUID, _ value: String) {
    lock.withLock { if token == attempt { state = value } }
  }
  static func error(_ error: Error) -> RPCError {
    if let rpc = error as? RPCError { return rpc }
    let ns = error as NSError
    if ns.domain == SCStreamErrorDomain && [SCStreamError.Code.userDeclined.rawValue, SCStreamError.Code.userStopped.rawValue].contains(ns.code) {
      return RPCError(.captureDenied, "macOS denied or stopped screen capture. Ask the user to allow Litch Computer Use in the system prompt or Screen Recording settings, then retry. Do not bypass the prompt.")
    }
    return RPCError(.captureFailed, "Window capture failed (\(ns.domain), \(ns.code)). No usable frame was received; retry after the user checks the screen capture prompt and window.")
  }
  static var pendingError: RPCError {
    RPCError(.capturePending, "Screen capture is suspended or waiting for macOS confirmation. In the screen/window access prompt, the user should click Allow. Permission preflight alone does not confirm capture works. This call has stopped; retry after confirmation.")
  }
}
