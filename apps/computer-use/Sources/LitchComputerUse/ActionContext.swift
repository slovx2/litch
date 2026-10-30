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
    if UserActivity.isBusy(pid: pid) { throw RPCError(.userActive, "The user took over the target app. Call get_app_state before retrying.") }
  }

  func checkBase() throws {
    try checkLease()
    try Engine.requireDesktop()
    guard !app.isTerminated else { throw RPCError(.notFound, "The target app exited.") }
    if foreground, NSWorkspace.shared.frontmostApplication?.processIdentifier != pid {
      throw RPCError(.userActive, "The foreground changed during the action; input stopped.")
    }
  }

  func inForeground<T>(kind: String, point: CGPoint? = nil, _ body: () throws -> T) throws -> T {
    return try ForegroundExcursion.run(app: app, window: window?.element ?? accessibleWindow,
      check: { try self.checkBase() }, notice: { state in
        if state == "foreground" { self.usedForeground = true }
        self.notice(state, kind, point, false)
      }) {
        self.foreground = true
        defer { self.foreground = false }
        // 等待空闲期间的输入不算动作中接管，以真正执行前的 revision 为准。
        let executionRevision = UserActivity.revision
        self.notice("dispatched", kind, point, true)
        let value = try body()
        guard UserActivity.revision == executionRevision else {
          throw RPCError(.userActive, "The user intervened; the action may be partially completed.")
        }
        return value
      }
  }

  func mouse(kind: String, point: CGPoint, body: (NativeWindow?) throws -> Void) throws {
    try checkBase()
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
