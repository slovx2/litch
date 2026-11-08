// 最小私有鼠标窗口路由。键盘不经过这里；不合成焦点，不使用 tag 或私有投递函数。
import AppKit
import ApplicationServices
import Darwin
import LitchComputerUseCore

struct NativeWindow {
  let pid: pid_t
  let id: CGWindowID
  let frame: CGRect
  let element: AXUIElement

  static func resolve(_ pid: pid_t) throws -> NativeWindow {
    guard let element = AXReader.keyWindow(AXReader.appElement(pid)),
      let ax = AXReader.frame(of: element) else {
      throw RPCError(.notFound, "The app has no accessible window.")
    }
    let rows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], 0)
      as? [[String: Any]] ?? []
    let matches = rows.filter { row in
      guard row[kCGWindowOwnerPID as String] as? Int32 == pid,
        row[kCGWindowLayer as String] as? Int == 0,
        let bounds = row[kCGWindowBounds as String] as? [String: Double] else { return false }
      return abs((bounds["X"] ?? .infinity) - ax.origin.x) < 2 &&
        abs((bounds["Y"] ?? .infinity) - ax.origin.y) < 2 &&
        abs((bounds["Width"] ?? .infinity) - ax.size.width) < 2 &&
        abs((bounds["Height"] ?? .infinity) - ax.size.height) < 2
    }
    guard matches.count == 1, let id = matches[0][kCGWindowNumber as String] as? UInt32 else {
      throw RPCError(.stale, "The visible window could not be identified uniquely. Call get_app_state again.")
    }
    return NativeWindow(pid: pid, id: id, frame: CGRect(x: ax.origin.x, y: ax.origin.y,
      width: ax.size.width, height: ax.size.height), element: element)
  }

  func validate() throws {
    let now = try NativeWindow.resolve(pid)
    guard now.id == id, now.frame == frame else {
      throw RPCError(.stale, "The target window moved or changed. Call get_app_state again.")
    }
  }
}

enum BackgroundMouse {
  typealias Location = @convention(c) (CGEvent, CGPoint) -> Void
  typealias Field = @convention(c) (CGEvent, UInt32, Int64) -> Void
  private static let library = dlopen("/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight", RTLD_NOW)
  private static let location = dlsym(library, "CGEventSetWindowLocation").map { unsafeBitCast($0, to: Location.self) }
  private static let field = dlsym(library, "SLEventSetIntegerValueField").map { unsafeBitCast($0, to: Field.self) }
  private static let lock = NSLock()
  private static var state = "pending"

  static var status: String { lock.lock(); defer { lock.unlock() }; return state }
  static var available: Bool { status == "available" }
  static func finish(_ result: String) { lock.lock(); state = result; lock.unlock() }

  /// 首个动作不能把 pending 当作不可用而抢前台，污染仍在采样的自测。
  /// 在请求线程等待，保留主线程处理自测事件与控制面处理取消的机会。
  static func waitForSelfTest(check: () throws -> Void) throws {
    let deadline = ProcessInfo.processInfo.systemUptime + 2
    while status == "pending" {
      try check()
      guard ProcessInfo.processInfo.systemUptime < deadline else {
        throw RPCError(.failed, "The input self-test has not completed; no input was sent. Retry after startup.")
      }
      Thread.sleep(forTimeInterval: 0.01)
    }
    try check()
  }

  static func route(_ event: CGEvent, pid: pid_t, window: CGWindowID, frame: CGRect) throws {
    guard let location, let field else { throw RPCError(.failed, "Background mouse symbols unavailable.") }
    event.setIntegerValueField(.mouseEventWindowUnderMousePointer, value: Int64(window))
    event.setIntegerValueField(.mouseEventWindowUnderMousePointerThatCanHandleThisEvent, value: Int64(window))
    field(event, 51, Int64(window))
    location(event, CGPoint(x: event.location.x - frame.minX, y: event.location.y - frame.minY))
    Input.mark(event)
    event.postToPid(pid)
  }

  /// 每个助手进程只测一次自有窗口的实际事件；符号存在不等于路由可用。
  static func startSelfTest() {
    guard Permissions.accessibility(), location != nil, field != nil else {
      finish("unavailable"); return
    }
    let window = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 32, height: 32),
      styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
    let view = MouseTestView(frame: NSRect(x: 0, y: 0, width: 32, height: 32))
    window.contentView = view
    window.isOpaque = false
    window.backgroundColor = .clear
    window.hasShadow = false
    window.sharingType = .none
    window.orderBack(nil)
    let front = NSWorkspace.shared.frontmostApplication?.processIdentifier
    let cursor = CGEvent(source: nil)?.location
    let top = NSScreen.screens.first?.frame.maxY ?? 0
    let frame = CGRect(x: window.frame.minX, y: top - window.frame.maxY, width: 32, height: 32)
    let id = CGWindowID(window.windowNumber)
    let started = Date()
    DispatchQueue.global().async {
      let point = CGPoint(x: frame.midX, y: frame.midY)
      do {
        for type in [CGEventType.leftMouseDown, .leftMouseUp] {
          guard let event = CGEvent(mouseEventSource: nil, mouseType: type,
            mouseCursorPosition: point, mouseButton: .left) else { throw RPCError(.failed, "event") }
          try route(event, pid: getpid(), window: id, frame: frame)
          Thread.sleep(forTimeInterval: 0.04)
        }
        guard let scroll = CGEvent(scrollWheelEvent2Source: nil, units: .pixel,
          wheelCount: 1, wheel1: -20, wheel2: 0, wheel3: 0) else { throw RPCError(.failed, "event") }
        scroll.location = point
        try route(scroll, pid: getpid(), window: id, frame: frame)
      } catch { finish("unavailable") }
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
        let frontStable = NSWorkspace.shared.frontmostApplication?.processIdentifier == front
        let cursorStable = CGEvent(source: nil)?.location == cursor
        let ok = view.clicked && view.scrolled && frontStable && cursorStable
        finish(ok ? "available" : "unavailable")
        window.orderOut(nil)
        Log.write("后台鼠标启动自测：\(status)；click=\(view.clicked) scroll=\(view.scrolled) frontStable=\(frontStable) cursorStable=\(cursorStable) elapsedMs=\(Int(Date().timeIntervalSince(started) * 1000))；SIP 开启未验")
      }
    }
  }
}

private final class MouseTestView: NSView {
  var clicked = false
  var scrolled = false
  override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
  override func mouseDown(with event: NSEvent) { clicked = true }
  override func scrollWheel(with event: NSEvent) { scrolled = true }
}
