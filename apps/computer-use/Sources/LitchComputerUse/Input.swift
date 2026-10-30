// 键盘始终用公开 postToPid 逐字符/键码投递；鼠标有窗口路由时后台发送，否则在短暂前台路径发系统事件。
// 每个事件都打上我们自己的标记（eventSourceUserData），屏幕提示那边监听用户键鼠时据此把自己发的认出来、不算用户在动。
// 事件源用私有状态：用户手上按着的修饰键不会混进我们发的事件。
import CoreGraphics
import Foundation
import LitchComputerUseCore

enum Input {
  /// 打在我们发的事件上的标记
  static let marker: Int64 = 0x4C49_5443_4855  // “LITCHU”
  private static let source = CGEventSource(stateID: .privateState)
  private static let lock = NSLock()
  private static var lastPosted = Date.distantPast

  /// 最近一次发事件的时间（屏幕提示判断“用户在动”时，紧跟在我们事件后面的系统回声不算）
  static var lastPostedAt: Date {
    lock.lock()
    defer { lock.unlock() }
    return lastPosted
  }

  static func mark(_ event: CGEvent) {
    event.setIntegerValueField(.eventSourceUserData, value: marker)
    lock.lock()
    lastPosted = Date()
    lock.unlock()
  }

  private static func post(_ event: CGEvent?) {
    guard let event else { return }
    mark(event)
    event.post(tap: .cghidEventTap)
  }

  private static func post(_ event: CGEvent?, to pid: pid_t) {
    guard let event else { return }
    mark(event)
    event.postToPid(pid)
  }

  enum Button: String {
    case left, right, middle

    var cg: CGMouseButton {
      switch self {
      case .left: return .left
      case .right: return .right
      case .middle: return .center
      }
    }

    var types: (down: CGEventType, up: CGEventType, drag: CGEventType) {
      switch self {
      case .left: return (.leftMouseDown, .leftMouseUp, .leftMouseDragged)
      case .right: return (.rightMouseDown, .rightMouseUp, .rightMouseDragged)
      case .middle: return (.otherMouseDown, .otherMouseUp, .otherMouseDragged)
      }
    }
  }

  static func move(to point: CGPoint) {
    post(pointerMove(to: point))
    Thread.sleep(forTimeInterval: 0.03)
  }

  /// 前台恢复只还原指针位置，不把私有源上一次快捷键的修饰键带到 HID 层。
  static func pointerMove(to point: CGPoint) -> CGEvent? {
    let event = CGEvent(mouseEventSource: source, mouseType: .mouseMoved,
      mouseCursorPosition: point, mouseButton: .left)
    event?.flags = []
    return event
  }

  static func click(at point: CGPoint, button: Button, count: Int, flags: UInt64,
    window: NativeWindow? = nil, check: () throws -> Void = {}) throws {
    try check()
    if window == nil { move(to: point) }
    for click in 1...max(1, min(count, 3)) {
      for type in [button.types.down, button.types.up] {
        let event = CGEvent(
          mouseEventSource: source, mouseType: type, mouseCursorPosition: point,
          mouseButton: button.cg)
        event?.setIntegerValueField(.mouseEventClickState, value: Int64(click))
        event?.flags = CGEventFlags(rawValue: flags)
        if type == button.types.down { try check() }
        if let window, let event {
          try BackgroundMouse.route(event, pid: window.pid, window: window.id, frame: window.frame)
        } else { post(event) }
        Thread.sleep(forTimeInterval: 0.02)
      }
      Thread.sleep(forTimeInterval: 0.05)
    }
  }

  static func drag(from start: CGPoint, to end: CGPoint, check: () throws -> Void = {}) throws {
    try check()
    move(to: start)
    post(
      CGEvent(
        mouseEventSource: source, mouseType: .leftMouseDown, mouseCursorPosition: start,
        mouseButton: .left))
    // 中止也释放代理按下的按钮，避免把拖动留给用户。
    defer {
      post(CGEvent(mouseEventSource: source, mouseType: .leftMouseUp,
        mouseCursorPosition: CGEvent(source: nil)?.location ?? end, mouseButton: .left))
    }
    Thread.sleep(forTimeInterval: 0.08)
    let steps = 12
    for step in 1...steps {
      try check()
      let t = Double(step) / Double(steps)
      let point = CGPoint(
        x: start.x + (end.x - start.x) * t, y: start.y + (end.y - start.y) * t)
      post(
        CGEvent(
          mouseEventSource: source, mouseType: .leftMouseDragged, mouseCursorPosition: point,
          mouseButton: .left))
      Thread.sleep(forTimeInterval: 0.02)
    }
    Thread.sleep(forTimeInterval: 0.05)
  }

  /// 滚动：dy 正数往上滚（内容往下走），dx 正数往左。单位是行。
  static func scroll(at point: CGPoint, dx: Int32, dy: Int32, steps: Int,
    window: NativeWindow? = nil, check: () throws -> Void = {}) throws {
    try check()
    if window == nil { move(to: point) }
    var wheelX = dx, wheelY = dy
    if window == nil {
      guard let natural = CFPreferencesCopyValue("com.apple.swipescrolldirection" as CFString,
        kCFPreferencesAnyApplication, kCFPreferencesCurrentUser, kCFPreferencesAnyHost) as? Bool else {
        throw RPCError(.failed, "Could not determine the system scroll direction; no scroll event was sent.")
      }
      wheelX = InputPolicy.systemScrollDelta(dx, natural: natural)
      wheelY = InputPolicy.systemScrollDelta(dy, natural: natural)
    }
    for _ in 0..<max(1, steps) {
      try check()
      let event = CGEvent(
        scrollWheelEvent2Source: source, units: .line, wheelCount: 2, wheel1: wheelY, wheel2: wheelX,
        wheel3: 0)
      event?.location = point
      if let window, let event {
        try BackgroundMouse.route(event, pid: window.pid, window: window.id, frame: window.frame)
      } else if let event {
        // 系统路径会应用自然滚动偏好；预先归一化，保持与后台定向投递相同的内容方向。
        mark(event)
        event.post(tap: .cghidEventTap)
      }
      Thread.sleep(forTimeInterval: 0.02)
    }
  }

  /// 测试可替换投递与读回，不向真实桌面发送事件。
  struct KeyboardIO {
    var target: (CGEvent, pid_t) -> Void = { post($0, to: $1) }
    var system: (CGEvent) -> Void = { post($0) }
    var flags: () -> UInt64 = {
      CGEventSource.flagsState(.combinedSessionState).rawValue |
        CGEventSource.flagsState(.hidSystemState).rawValue
    }
    var revision: () -> UInt64 = { UserActivity.revision }
    var pause: () -> Void = { Thread.sleep(forTimeInterval: 0.02) }
  }

  /// 返回是否补发过系统层的修饰键松开；失败和取消也先收尾，再把原错误交回。
  @discardableResult
  static func key(_ combo: KeyCombo, pid: pid_t, check: () throws -> Void = {},
    io: KeyboardIO = KeyboardIO()) throws -> Bool {
    try check()
    guard let down = CGEvent(keyboardEventSource: source, virtualKey: combo.keyCode, keyDown: true),
      let up = CGEvent(keyboardEventSource: source, virtualKey: combo.keyCode, keyDown: false) else {
      throw RPCError(.failed, "Could not create keyboard events; no input was sent.")
    }
    let before = io.revision()
    let initialFlags = io.flags()
    down.flags = CGEventFlags(rawValue: combo.flags)
    // keyUp 继续带 Command 会污染私有源，恢复指针时再传到系统层，后续空闲检查就一直失败。
    up.flags = []
    mark(down); io.target(down, pid)
    io.pause()
    var error: Error?
    do { try check() } catch let failure { error = failure }
    mark(up); io.target(up, pid)
    releaseModifiers(combo.flags, pid: pid, io: io)

    // 动作开始前已经存在的修饰键不属于本次注入，不能替用户松开。
    let mask = combo.flags & ~initialFlags & (Keys.command | Keys.shift | Keys.option | Keys.control | Keys.function)
    var residual = io.flags() & mask
    var repaired = false
    // 真用户介入后不能用全局松开覆盖他的修饰键。目标进程上的代理 keyUp 已完成，直接让行。
    if residual != 0, io.revision() == before {
      releaseModifiers(residual, pid: pid, system: true, io: io)
      repaired = true
      residual = io.flags() & mask
    }
    if io.revision() != before {
      throw RPCError(.userActive, "The user intervened during the shortcut. Targeted keys were released; no further input will be sent.")
    }
    if residual != 0 {
      throw RPCError(.failed, "Modifier keys remained set after release and one recovery attempt. Stop and ask the user to press and release the modifier keys before continuing.")
    }
    if let error {
      let original = error as? RPCError
      throw RPCError(original?.kind ?? .failed,
        (original?.message ?? String(describing: error)) + (repaired ? " Residual modifier keys were detected and released." : " Targeted keys were released."))
    }
    return repaired
  }

  /// 只松开本次注入的修饰键，仍用同一个私有事件源、标记和目标进程；清理不被取消检查拦下。
  static func releaseModifiers(_ flags: UInt64, pid: pid_t, system: Bool = false,
    io: KeyboardIO = KeyboardIO()) {
    for (mask, code) in [(Keys.command, UInt16(55)), (Keys.shift, 56), (Keys.option, 58), (Keys.control, 59), (Keys.function, 63)] where flags & mask != 0 {
      guard let up = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: false) else { continue }
      up.type = .flagsChanged
      up.flags = []
      mark(up)
      if system { io.system(up) } else { io.target(up, pid) }
    }
    io.pause()
  }

  /// 打字：每个字符单独一对 Unicode 事件；整串在 Chromium 后台会丢。换行、Tab 用键码。
  static func type(_ text: String, pid: pid_t, check: () throws -> Void = {}) throws {
    func send(_ chunk: [UniChar]) {
      for down in [true, false] {
        let event = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: down)
        event?.flags = []
        chunk.withUnsafeBufferPointer { buffer in
          event?.keyboardSetUnicodeString(stringLength: buffer.count, unicodeString: buffer.baseAddress)
        }
        post(event, to: pid)
      }
      Thread.sleep(forTimeInterval: 0.01)
    }
    for character in text {
      try check()
      if character == "\n" || character == "\r\n" || character == "\r" {
        try key(KeyCombo(keyCode: 0x24, flags: 0), pid: pid, check: check)
      } else if character == "\t" {
        try key(KeyCombo(keyCode: 0x30, flags: 0), pid: pid, check: check)
      } else {
        let units = Array(String(character).utf16)
        send(units)
      }
    }
  }
}
