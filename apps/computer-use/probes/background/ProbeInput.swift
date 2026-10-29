// 探针专用：每条路径单独标记，缺私有符号时报错，绝不偷偷回退到别的路径。
import ApplicationServices
import CoreGraphics
import Darwin
import Foundation

enum ProbeFailure: Error { case unavailable(String) }

enum ProbeInput {
  static let marker: Int64 = 0x4c495443484d30
  static let source = CGEventSource(stateID: .privateState)
  static let sky = dlopen("/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight", RTLD_NOW)
  static let carbon = dlopen("/System/Library/Frameworks/Carbon.framework/Carbon", RTLD_NOW)
  typealias Post = @convention(c) (pid_t, CGEvent) -> Void
  typealias Location = @convention(c) (CGEvent, CGPoint) -> Void
  typealias PSNForPID = @convention(c) (pid_t, UnsafeMutableRawPointer) -> Int32
  typealias FocusRecord = @convention(c) (UnsafeRawPointer, UnsafeRawPointer) -> Int32

  static func symbol<T>(_ name: String, _ type: T.Type) throws -> T {
    guard let pointer = dlsym(sky, name) ?? dlsym(carbon, name) else {
      throw ProbeFailure.unavailable(name)
    }
    return unsafeBitCast(pointer, to: type)
  }

  static func capabilities() -> [String: Bool] {
    Dictionary(uniqueKeysWithValues: ["SLEventPostToPid", "CGEventSetWindowLocation",
      "SLPSPostEventRecordTo", "GetProcessForPID"].map { ($0, dlsym(sky, $0) != nil || dlsym(carbon, $0) != nil) })
  }

  // 依据公开的开源接口研究，自行构造测试记录；不用官方 ChatGPT 的实现。
  // 参考见 README。仅给目标发焦点记录，不调用 SetFrontProcess，不给前台应用发失活记录。
  static func focus(pid: pid_t, window: UInt32, enabled: Bool) throws -> Int32 {
    let resolve = try symbol("GetProcessForPID", PSNForPID.self)
    let post = try symbol("SLPSPostEventRecordTo", FocusRecord.self)
    var psn = [UInt32](repeating: 0, count: 2)
    let resolved = psn.withUnsafeMutableBytes { resolve(pid, $0.baseAddress!) }
    guard resolved == 0 else { throw ProbeFailure.unavailable("GetProcessForPID status=\(resolved)") }
    var record = [UInt8](repeating: 0, count: 248)
    record[4] = 248
    record[8] = 13
    record[138] = enabled ? 1 : 2
    for offset in 0..<4 { record[60 + offset] = UInt8((window >> (8 * offset)) & 255) }
    return psn.withUnsafeBytes { process in
      record.withUnsafeBytes { event in post(process.baseAddress!, event.baseAddress!) }
    }
  }

  static func send(_ event: CGEvent, pid: pid_t, window: UInt32,
                   backend: String, frame: CGRect, mouse: Bool) throws {
    event.setIntegerValueField(.eventSourceUserData, value: marker)
    event.flags = []
    if backend != "public" {
      // 这两个窗口字段有公开枚举，与私有的窗口局部坐标字段分开测。
      event.setIntegerValueField(.mouseEventWindowUnderMousePointer, value: Int64(window))
      event.setIntegerValueField(.mouseEventWindowUnderMousePointerThatCanHandleThisEvent, value: Int64(window))
    }
    if backend == "private" {
      if mouse {
        let setLocation = try symbol("CGEventSetWindowLocation", Location.self)
        setLocation(event, CGPoint(x: event.location.x - frame.minX, y: event.location.y - frame.minY))
      }
      let post = try symbol("SLEventPostToPid", Post.self)
      post(pid, event)
    } else {
      event.postToPid(pid)
    }
  }

  static func events(action: String, point: CGPoint) throws -> [CGEvent] {
    switch action {
    case "click":
      return [CGEventType.leftMouseDown, .leftMouseUp].compactMap { type in
        let event = CGEvent(mouseEventSource: source, mouseType: type,
          mouseCursorPosition: point, mouseButton: .left)
        event?.setIntegerValueField(.mouseEventClickState, value: 1)
        return event
      }
    case "scroll":
      guard let event = CGEvent(scrollWheelEvent2Source: source, units: .pixel,
        wheelCount: 1, wheel1: -120, wheel2: 0, wheel3: 0) else { return [] }
      event.location = point
      return [event]
    case "english", "chinese":
      let units = Array((action == "english" ? "abcXYZ" : "中文测试").utf16)
      return [true, false].compactMap { down in
        let event = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: down)
        units.withUnsafeBufferPointer { buffer in
          event?.keyboardSetUnicodeString(stringLength: buffer.count, unicodeString: buffer.baseAddress)
        }
        return event
      }
    case "keycode":
      return [true, false].compactMap { CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: $0) }
    default: throw ProbeFailure.unavailable("unknown action \(action)")
    }
  }
}
