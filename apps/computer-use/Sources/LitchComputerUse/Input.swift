// 键鼠事件。鼠标事件发到系统的事件流里（目标应用已经在前台，点到的就是它）；键盘事件直接发给目标进程，
// 不会触发别的应用的全局快捷键。
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

  private static func mark(_ event: CGEvent) {
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
    post(
      CGEvent(
        mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: point,
        mouseButton: .left))
    Thread.sleep(forTimeInterval: 0.03)
  }

  static func click(at point: CGPoint, button: Button, count: Int, flags: UInt64) {
    move(to: point)
    for click in 1...max(1, min(count, 3)) {
      for type in [button.types.down, button.types.up] {
        let event = CGEvent(
          mouseEventSource: source, mouseType: type, mouseCursorPosition: point,
          mouseButton: button.cg)
        event?.setIntegerValueField(.mouseEventClickState, value: Int64(click))
        event?.flags = CGEventFlags(rawValue: flags)
        post(event)
        Thread.sleep(forTimeInterval: 0.02)
      }
      Thread.sleep(forTimeInterval: 0.05)
    }
  }

  static func drag(from start: CGPoint, to end: CGPoint) {
    move(to: start)
    post(
      CGEvent(
        mouseEventSource: source, mouseType: .leftMouseDown, mouseCursorPosition: start,
        mouseButton: .left))
    Thread.sleep(forTimeInterval: 0.08)
    let steps = 12
    for step in 1...steps {
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
    post(
      CGEvent(
        mouseEventSource: source, mouseType: .leftMouseUp, mouseCursorPosition: end,
        mouseButton: .left))
  }

  /// 滚动：dy 正数往上滚（内容往下走），dx 正数往左。单位是行
  static func scroll(at point: CGPoint, dx: Int32, dy: Int32, steps: Int) {
    move(to: point)
    for _ in 0..<max(1, steps) {
      let event = CGEvent(
        scrollWheelEvent2Source: source, units: .line, wheelCount: 2, wheel1: dy, wheel2: dx,
        wheel3: 0)
      event?.location = point
      post(event)
      Thread.sleep(forTimeInterval: 0.02)
    }
  }

  static func key(_ combo: KeyCombo, pid: pid_t) {
    let flags = CGEventFlags(rawValue: combo.flags)
    for down in [true, false] {
      let event = CGEvent(keyboardEventSource: source, virtualKey: combo.keyCode, keyDown: down)
      event?.flags = flags
      post(event, to: pid)
      Thread.sleep(forTimeInterval: 0.015)
    }
  }

  /// 打字：按 Unicode 串发，不依赖键盘布局；换行、制表符按真的回车键、Tab 键发
  static func type(_ text: String, pid: pid_t) {
    var chunk: [UniChar] = []
    func flush() {
      guard !chunk.isEmpty else { return }
      for down in [true, false] {
        let event = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: down)
        event?.flags = []
        chunk.withUnsafeBufferPointer { buffer in
          event?.keyboardSetUnicodeString(stringLength: buffer.count, unicodeString: buffer.baseAddress)
        }
        post(event, to: pid)
      }
      chunk.removeAll()
      Thread.sleep(forTimeInterval: 0.01)
    }
    for character in text {
      if character == "\n" || character == "\r\n" || character == "\r" {
        flush()
        key(KeyCombo(keyCode: 0x24, flags: 0), pid: pid)
      } else if character == "\t" {
        flush()
        key(KeyCombo(keyCode: 0x30, flags: 0), pid: pid)
      } else {
        let units = Array(String(character).utf16)
        if chunk.count + units.count > 16 { flush() }
        chunk.append(contentsOf: units)
      }
    }
    flush()
  }
}
