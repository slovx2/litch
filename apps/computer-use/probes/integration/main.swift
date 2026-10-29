// 隔离验收入口：编译同一份产品 Engine/Input/Capture。仅这个测试入口使用一次性令牌，
// 便于未签名的开发外壳连接独立签名探针；产品 main.swift 的团队验签完全不变。
import AppKit
import LitchComputerUseCore

let environment = ProcessInfo.processInfo.environment
guard let directory = environment["LITCH_COMPUTER_USE_DIR"], directory.hasPrefix("/tmp/litch-cu-"),
  let token = environment["LITCH_COMPUTER_USE_TOKEN"], token.count >= 32 else {
  fatalError("隔离探针需要独立目录与一次性令牌")
}
try FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
Log.open(directory: directory)
let server = Server(socketPath: directory + "/helper.sock") {
  Engine(connection: $0, mode: .token(token), ownTeam: nil)
}
try server.start()
try Data("\(getpid())\n".utf8).write(to: URL(fileURLWithPath: directory + "/helper.pid"))
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
Overlay.shared.onStop = { Activity.shared.stopAll() }
Overlay.shared.installMonitors()
let auditPath = directory + "/foreground.json"
// 只记录事件类别/来源和鼠标位移，不记录键码、字符或窗口文字。
// 用于区分真实接管与激活窗口后系统合成的零位移鼠标事件。
var activity: [String: Any] = [:]
var lastSnapshotRequest: Data?
let activityMonitor = NSEvent.addGlobalMonitorForEvents(matching: [
  .keyDown, .leftMouseDown, .rightMouseDown, .otherMouseDown, .scrollWheel, .mouseMoved,
  .leftMouseDragged, .rightMouseDragged, .otherMouseDragged, .flagsChanged,
]) { event in
  let cg = event.cgEvent
  if cg?.getIntegerValueField(.eventSourceUserData) == Input.marker { return }
  activity = ["type": event.type.rawValue, "time": Date().timeIntervalSince1970,
    "sourcePid": cg?.getIntegerValueField(.eventSourceUnixProcessID) ?? -1,
    "deltaX": cg?.getIntegerValueField(.mouseEventDeltaX) ?? 0,
    "deltaY": cg?.getIntegerValueField(.mouseEventDeltaY) ?? 0]
}
let audit = Timer.scheduledTimer(withTimeInterval: 0.05, repeats: true) { _ in
  // 浮窗禁止系统窗口截图；验收只导出本探针自己的真实 NSView 位图，不改变产品捕获策略。
  if let request = try? Data(contentsOf: URL(fileURLWithPath: directory + "/preview-snapshot.request")),
    request != lastSnapshotRequest,
    let panel = NSApp.windows.first(where: { $0.title == "Litch" && $0.isVisible }),
    let view = panel.contentView,
    let bitmap = view.bitmapImageRepForCachingDisplay(in: view.bounds) {
    view.cacheDisplay(in: view.bounds, to: bitmap)
    if let data = bitmap.representation(using: .png, properties: [:]) {
      try? data.write(to: URL(fileURLWithPath: directory + "/preview-panel.png"), options: .atomic)
      lastSnapshotRequest = request
    }
  }
  let front = NSWorkspace.shared.frontmostApplication
  let cursor = CGEvent(source: nil)?.location ?? .zero
  let panel = NSApp.windows.first(where: { $0 is PreviewPanel && $0.isVisible })
  // 仅视觉验收显式允许截本探针浮窗；正式助手仍为 sharingType.none。
  if environment["LITCH_CU_PROBE_SHARE_PREVIEW"] == "1" { panel?.sharingType = .readOnly }
  let value: [String: Any] = ["pid": getpid(), "previewWindowID": panel?.windowNumber ?? 0, "frontPid": front?.processIdentifier ?? 0,
    "frontBundle": front?.bundleIdentifier ?? "", "idle": UserActivity.idleSeconds,
    "cursorX": cursor.x, "cursorY": cursor.y, "sampledAt": Date().timeIntervalSince1970,
    "lastActivity": activity]
  if let data = try? JSONSerialization.data(withJSONObject: value) { try? data.write(to: URL(fileURLWithPath: auditPath), options: .atomic) }
}
DispatchQueue.main.async {
  if environment["LITCH_CU_PROBE_NO_PRIVATE"] == "1" { BackgroundMouse.finish("unavailable") }
  else { BackgroundMouse.startSelfTest() }
}
app.run()
