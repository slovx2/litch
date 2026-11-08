// 前台执行只等待正在按住的输入或组字；查看、移动和滚动不构成接管。
import AppKit
import ApplicationServices
import LitchComputerUseCore

enum ForegroundExcursion {
  static func run<T>(app: NSRunningApplication, window: AXUIElement?, check: () throws -> Void,
    notice: (String) -> Void, body: () throws -> T) throws -> T {
    let started = ProcessInfo.processInfo.systemUptime
    notice("waitingForIdle")
    waiting: while true {
      try check()
      let held = UserActivity.heldInput()
      let composing = UserActivity.isComposing
      switch InputPolicy.waitResult(elapsed: ProcessInfo.processInfo.systemUptime - started,
        blocked: held.blocked || composing, cancelled: false) {
      case "ready": break waiting
      case "userActive":
        let reason = held.blocked ? "A physical mouse button or key is currently held" : "The currently focused control reports active IME composition"
        throw RPCError(.userActive, "\(reason). No foreground input was sent. Release the input or finish composing, then call get_app_state and retry this step in the same turn; input state is checked again on every attempt. The session is not stopped.")
      default: break
      }
      Thread.sleep(forTimeInterval: 0.05)
    }
    try check()
    guard let previous = NSWorkspace.shared.frontmostApplication,
      previous.bundleIdentifier != "com.apple.loginwindow" else {
      throw RPCError(.userActive, "The desktop is locked or has no foreground app.")
    }
    let oldApp = AXReader.appElement(previous.processIdentifier)
    let oldWindow = AXReader.keyWindow(oldApp)
    let oldFocus: AXUIElement? = AXReader.copy(oldApp, kAXFocusedUIElementAttribute as String)
    let cursor = CGEvent(source: nil)?.location
    let revision = UserActivity.revision
    let targetRevision = UserActivity.targetRevision(pid: app.processIdentifier)
    var raised = false
    defer {
      // 用户已切到别处或开始输入时尊重接管，不用恢复动作覆盖用户的新选择。
      if raised, UserActivity.targetRevision(pid: app.processIdentifier) == targetRevision,
        NSWorkspace.shared.frontmostApplication?.processIdentifier == app.processIdentifier,
        !previous.isTerminated {
        do {
          try Apps.activate(previous, window: oldWindow)
          if UserActivity.targetRevision(pid: app.processIdentifier) == targetRevision,
            NSWorkspace.shared.frontmostApplication?.processIdentifier == previous.processIdentifier {
            if let oldFocus { AXUIElementSetAttributeValue(oldFocus, kAXFocusedAttribute as CFString, kCFBooleanTrue) }
            // AX 调用返回成功也可能没有恢复焦点；分别核对窗口与元素，不把尝试当作成功。
            let windowOK = oldWindow.map { expected in
              AXReader.keyWindow(oldApp).map { CFEqual($0, expected) } == true
            } ?? true
            let focusOK = oldFocus.map { expected in
              let actual: AXUIElement? = AXReader.copy(oldApp, kAXFocusedUIElementAttribute as String)
              return actual.map { CFEqual($0, expected) } == true
            } ?? true
            // 用户移动过光标就保留其位置，但不因此放弃恢复应用焦点。
            if UserActivity.revision == revision, let cursor, CGEvent(source: nil)?.location != cursor { Input.move(to: cursor) }
            notice(windowOK && focusOK ? "restored" : "restoreFailed")
          } else { notice("yielded") }
        } catch { notice("restoreFailed") }
      } else if raised { notice("yielded") }
    }
    let restorePreviewInput = FloatingPreview.passThroughDuringInput()
    defer { restorePreviewInput() }
    // 目标本来就在前台时，没有借用其他应用的焦点，也不该在结束时重置目标自己的焦点。
    raised = previous.processIdentifier != app.processIdentifier
    try Apps.activate(app, window: window)
    if raised { notice("foreground") }
    try check()
    guard UserActivity.targetRevision(pid: app.processIdentifier) == targetRevision,
      !UserActivity.hasHeldInput, !UserActivity.isComposing else {
      throw RPCError(.userActive, "Input overlapped while activating the target app. Call get_app_state, then retry this step; the session is not stopped.")
    }
    return try body()
  }
}
