import AppKit
import ApplicationServices
import LitchComputerUseCore

final class ActionContext {
  let session: String
  let app: NSRunningApplication
  let key: String
  let actionId: String
  let checkLease: () throws -> Void
  let notice: (String, String, CGPoint?, Bool) -> Void
  var foreground = false
  var usedForeground = false
  private var restoration = "pending"
  var foregroundNote: String {
    guard usedForeground else { return "" }
    switch restoration {
    case "restored": return "\nThis step briefly used the foreground; the previous app, window and focus were restored."
    case "yielded": return "\nThis step briefly used the foreground; restoration yielded to subsequent user activity."
    default: return "\nThis step briefly used the foreground; restoration could not be confirmed. Observe the current state before continuing."
    }
  }
  private var inputRevision: UInt64?
  private var pointerRevision: UInt64?
  var window: NativeWindow?
  var accessibleWindow: AXUIElement?
  var pid: pid_t { app.processIdentifier }

  init(session: String, app: NSRunningApplication, key: String, actionId: String,
    check: @escaping () throws -> Void, notice: @escaping (String, String, CGPoint?, Bool) -> Void) {
    self.session = session; self.app = app; self.key = key; self.actionId = actionId
    self.checkLease = check; self.notice = notice
  }

  var chromium: Bool {
    guard let root = app.bundleURL?.appendingPathComponent("Contents/Frameworks"),
      let names = try? FileManager.default.contentsOfDirectory(atPath: root.path) else { return false }
    return names.contains { $0.contains("Electron Framework") || $0.contains("Chrome Framework") ||
      $0.contains("Chromium Framework") || $0.contains("Brave Browser Framework") || $0.contains("Microsoft Edge Framework") }
  }

  func check() throws {
    try checkBase()
    try window?.validate()
  }

  func checkBase() throws {
    try checkLease()
    try Engine.requireDesktop()
    guard !app.isTerminated else { throw RPCError(.notFound, "The target app exited.") }
    if let inputRevision, UserActivity.targetRevision(pid: pid) != inputRevision {
      throw RPCError(.userActive, "Input overlapped in the target app; only this action stopped and it may be partially completed. Call get_app_state, then retry the unfinished step. The session is not stopped.")
    }
    // HID 状态也可能包含我们刚注入的 mouseDown；拖拽持有期间用真实事件版本判定碰撞。
    if foreground {
      let pointerConflict = pointerRevision.map { UserActivity.pointerRevision != $0 } ?? UserActivity.hasHeldPointer
      if pointerConflict || UserActivity.isComposing {
        throw RPCError(.userActive, "A pointer drag or IME composition overlaps this foreground step. Call get_app_state, then retry the unfinished step; the session is not stopped.")
      }
    }
    if foreground, NSWorkspace.shared.frontmostApplication?.processIdentifier != pid {
      throw RPCError(.userActive, "The input destination changed during this foreground action. Call get_app_state, then retry the unfinished step; the session is not stopped.")
    }
  }

  func withPointerInput<T>(_ body: () throws -> T) throws -> T {
    let revision = UserActivity.pointerRevision
    try check()
    pointerRevision = revision
    defer { pointerRevision = nil }
    return try body()
  }

  func inForeground<T>(kind: String, point: CGPoint? = nil, _ body: () throws -> T) throws -> T {
    return try ForegroundExcursion.run(app: app, window: window?.element ?? accessibleWindow,
      check: { try self.checkBase() }, notice: { state in
        if state == "foreground" { self.usedForeground = true }
        if ["restored", "restoreFailed", "yielded"].contains(state) { self.restoration = state }
        self.notice(state, kind, point, false)
      }) {
        self.foreground = true
        self.inputRevision = UserActivity.targetRevision(pid: self.pid)
        defer { self.foreground = false; self.inputRevision = nil }
        self.notice("dispatched", kind, point, true)
        let value = try body()
        try self.checkBase()
        return value
      }
  }

  func mouse(kind: String, point: CGPoint, body: (NativeWindow?) throws -> Void) throws {
    try checkBase()
    try BackgroundMouse.waitForSelfTest { try self.checkBase() }
    window = try NativeWindow.resolve(pid)
    notice("planned", kind, point, false)
    if InputPolicy.needsForeground(action: kind, chromium: chromium, mouseReady: BackgroundMouse.available) {
      // 不在真实目标上试点后再盲目重发；在派发前选路，防止重复副作用。
      notice("fallback", kind, point, false)
      try inForeground(kind: kind, point: point) { try body(nil) }
    } else {
      try check()
      try window?.validate()
      notice("dispatched", kind, point, false)
      try body(window)
    }
  }
}
