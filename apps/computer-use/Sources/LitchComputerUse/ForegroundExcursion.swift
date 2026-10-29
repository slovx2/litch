// 临时前台执行只在真实用户空闲后发生；用户中途接管时停止，不再抢回原窗口。
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
      switch InputPolicy.waitResult(elapsed: ProcessInfo.processInfo.systemUptime - started,
        idle: UserActivity.idleSeconds, cancelled: false) {
      case "ready": break waiting
      case "userActive":
        throw RPCError(.userActive, "The user is active. Timed out waiting for 2 seconds of idle time; no foreground action was performed.")
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
    var raised = false
    defer {
      // 用户已切到别处或开始输入时尊重接管，不用恢复动作覆盖用户的新选择。
      if raised, UserActivity.revision == revision,
        NSWorkspace.shared.frontmostApplication?.processIdentifier == app.processIdentifier,
        !previous.isTerminated {
        do {
          try Apps.activate(previous, window: oldWindow)
          if UserActivity.revision == revision,
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
            if UserActivity.revision == revision {
              if let cursor { Input.move(to: cursor) }
              notice(windowOK && focusOK ? "restored" : "restoreFailed")
            } else { notice("yielded") }
          } else { notice("yielded") }
        } catch { notice("restoreFailed") }
      } else if raised { notice("yielded") }
    }
    notice("foreground")
    raised = true
    try Apps.activate(app, window: window)
    try check()
    guard UserActivity.revision == revision else {
      throw RPCError(.userActive, "The user took over while the app was being activated.")
    }
    return try body()
  }
}
