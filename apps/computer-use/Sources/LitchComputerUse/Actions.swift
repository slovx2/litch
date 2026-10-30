// 动作：点击、打字、按键、滚动、设值、拖动、选中文字。
// 检查权限/观察窗口/租约；能后台做就定向投递，需要前台则等空闲并在结束后恢复。
// 每个输入阶段检查取消与用户接管；结束后返回 AX 差异，不把连续预览塞入模型结果。
// 元素按编号找（编号来自最近一次取状态或动作后的差异）；坐标是最近一次截图里的像素。
import AppKit
import ApplicationServices
import Foundation
import LitchComputerUseCore

extension Engine {
  func act(_ params: JSONValue, _ body: (ActionContext, JSONValue) throws -> String) throws
    -> JSONValue
  {
    let epoch = actionEpoch(params["session"]?.stringValue ?? "")
    let (session, app, key) = try prepare(params)
    let axWindow = AXReader.keyWindow(AXReader.appElement(app.processIdentifier))
    let window = try? NativeWindow.resolve(app.processIdentifier)
    try withState(session, key) { state in
      try state.observation.require(window?.id)
      let same = axWindow.map { current in state.observedAXWindow.map { CFEqual(current, $0) } ?? false }
        ?? (state.observedAXWindow == nil)
      guard same else { throw RPCError(.stale, "The accessible window changed. Call get_app_state again.") }
    }
    let owner = ownerPrefix(session)
    let token = try InputOwnership.shared.acquire(pid: app.processIdentifier, owner: owner)
    let actionId = params["actionId"]?.stringValue ?? UUID().uuidString
    defer {
      InputOwnership.shared.release(token)
      if !actionAllowed(actionId, session: session, epoch: epoch) { InputOwnership.shared.end(prefix: owner) }
    }
    let context = ActionContext(session: session, app: app, key: key, actionId: actionId,
      check: {
        guard self.actionAllowed(actionId, session: session, epoch: epoch), InputOwnership.shared.valid(pid: app.processIdentifier, owner: owner, token: token) else {
          throw RPCError(.stopped, "The action was cancelled or its input ownership ended.")
        }
      }, notice: { state, kind, point, foreground in
        self.preview.action(session: session, app: app, actionId: actionId,
          state: state, kind: kind, point: point, foreground: foreground)
      })
    context.window = window
    let done: String
    do {
      try BackgroundMouse.waitForSelfTest { try context.checkBase() }
      try context.checkBase()
      done = try body(context, params)
      context.notice("completed", "semantic", nil, context.usedForeground)
    } catch {
      context.notice("failed", "semantic", nil, context.usedForeground)
      throw error
    }
    Thread.sleep(forTimeInterval: 0.4)
    var text = done + (context.usedForeground ? "\nThe app was briefly brought to the foreground; restoration was attempted without overriding user activity." : "")
    do {
      let read = try AXReader().read(pid: app.processIdentifier)
      let current = try? NativeWindow.resolve(app.processIdentifier)
      let observedID = current.flatMap { native in read.window.flatMap { CFEqual(native.element, $0) ? native.id : nil } }
      let diff = withState(session, key) { state -> String in
        state.observation.observe(observedID)
        state.observedAXWindow = read.window
        if observedID == nil { state.observation.observeApplication(); state.shot = nil }
        let lines = state.book.lines(for: read.root)
        let diff = AXText.diff(
          previous: state.book.previous, current: lines, limit: AXText.actionDiffLimit)
        state.book.remember(lines)
        state.handles = read.handles
        state.lines = Dictionary(lines.map { ($0.index, $0) }, uniquingKeysWith: { a, _ in a })
        return diff ?? AXText.render(lines, limit: AXText.actionDiffLimit)
      }
      text += "\n\nObserved window: \(read.window == nil ? "none; application menu only (press_key and menu elements remain available)" : read.windowTitle ?? "untitled"). Changes in the app's accessibility tree since the last state:\n\(diff)"
      if diff == "(no changes since the last state)" {
        text += "\nInput dispatch alone does not confirm the intended result. Inspect the state before deciding the next action."
      }
    } catch {
      withState(session, key) { $0.observation.observe(nil) }
      text += "\n\n(Could not read the app's state after the action; call get_app_state.)"
    }
    return ["text": .string(text)]
  }

  // MARK: 找元素、换算坐标

  /// 按编号找元素
  func element(_ context: ActionContext, _ index: Int) throws -> (AXUIElement, AXLine) {
    try withState(context.session, context.key) { state in
      guard let line = state.lines[index], line.handle >= 0, line.handle < state.handles.count
      else {
        throw RPCError(
          .invalid,
          "Element [\(index)] is not in the latest state of this app. Call get_app_state and use a current number."
        )
      }
      return (state.handles[line.handle], line)
    }
  }

  /// 元素中心在屏幕上的点（现读位置，读不到用读树时的）
  func center(_ element: AXUIElement, _ line: AXLine) throws -> CGPoint {
    guard let frame = AXReader.frame(of: element) ?? line.frame, frame.size.width > 0 else {
      throw RPCError(.invalid, "Element has no position on screen; use coordinates instead.")
    }
    return CGPoint(x: frame.center.x, y: frame.center.y)
  }

  /// 截图像素 → 屏幕上的点。窗口挪了照挪；窗口大小变了就要求重新取状态
  func screenPoint(_ context: ActionContext, x: Double, y: Double) throws -> CGPoint {
    guard let window = context.window else { throw RPCError(.stale, "Call get_app_state again.") }
    try withState(context.session, context.key) { try $0.observation.require(window.id, screenshot: true) }
    let shot = withState(context.session, context.key) { $0.shot }
    guard let shot else {
      throw RPCError(.invalid, "No screenshot of this app yet. Call get_app_state first.")
    }
    let point = Point(x: x, y: y)
    guard Geometry.inside(point, image: shot.image) else {
      throw RPCError(
        .invalid,
        "(\(Int(x)), \(Int(y))) is outside the screenshot, which is \(Int(shot.image.width))x\(Int(shot.image.height)) pixels."
      )
    }
    guard let window = AXReader.keyWindow(AXReader.appElement(context.pid)),
      let now = AXReader.frame(of: window)
    else { throw RPCError(.stale, "The window is gone. Call get_app_state.") }
    guard abs(now.size.width - shot.axFrame.size.width) < 1,
      abs(now.size.height - shot.axFrame.size.height) < 1
    else {
      throw RPCError(
        .stale, "The window changed size since the screenshot. Call get_app_state again.")
    }
    let moved = Rect(
      x: shot.windowFrame.origin.x + now.origin.x - shot.axFrame.origin.x,
      y: shot.windowFrame.origin.y + now.origin.y - shot.axFrame.origin.y,
      width: shot.windowFrame.size.width, height: shot.windowFrame.size.height)
    guard
      let result = Geometry.screenPoint(
        imagePoint: point, image: shot.image, capturedWindow: shot.windowFrame.size, window: moved)
    else { throw RPCError(.stale, "Call get_app_state again.") }
    return CGPoint(x: result.x, y: result.y)
  }

  /// 动作的落点：给了 element 用元素中心，给了 x、y 用截图坐标；都没给时 required 为真就报错，否则用窗口中心
  func target(_ context: ActionContext, _ params: JSONValue, prefix: String = "", required: Bool)
    throws -> (point: CGPoint, element: (AXUIElement, AXLine)?)?
  {
    if let index = params["\(prefix)element"]?.intValue {
      let found = try element(context, index)
      return (try center(found.0, found.1), found)
    }
    if let x = params["\(prefix)x"]?.doubleValue, let y = params["\(prefix)y"]?.doubleValue {
      return (try screenPoint(context, x: x, y: y), nil)
    }
    if required {
      throw RPCError(.invalid, "Give either \(prefix)element or both \(prefix)x and \(prefix)y.")
    }
    return nil
  }

  func modifiers(_ params: JSONValue) throws -> UInt64 {
    guard let raw = params["modifiers"]?.stringValue, !raw.isEmpty else { return 0 }
    // 借按键的解析：在后面接一个键名，只取修饰位
    return try Keys.parse("\(raw)+a").flags
  }

  // MARK: 各个动作

  func click(_ context: ActionContext, _ params: JSONValue) throws -> String {
    let button = Input.Button(rawValue: params["button"]?.stringValue ?? "left") ?? .left
    let count = params["count"]?.intValue ?? 1
    let flags = try modifiers(params)
    if let index = params["element"]?.intValue, count == 1, flags == 0, !context.chromium {
      let (element, line) = try element(context, index)
      let point = try? center(element, line)
      try context.check()
      if button == .left, let row = AXReader.selectableRow(containing: element),
        AXUIElementSetAttributeValue(row, kAXSelectedAttribute as CFString, kCFBooleanTrue) == .success {
        context.notice("dispatched", "semantic", point, false)
        return "Selected the row containing [\(line.index)] \(line.content)."
      }
      let action = button == .right ? kAXShowMenuAction : kAXPressAction
      if button != .middle,
        AXUIElementPerformAction(element, action as CFString) == .success
      {
        context.notice("dispatched", "semantic", point, false)
        return "Pressed [\(line.index)] \(line.content)."
      }
      let role: String? = AXReader.copy(element, kAXRoleAttribute as String)
      if context.window == nil, button == .left, [kAXMenuBarItemRole, kAXMenuItemRole].contains(role ?? "") {
        try context.inForeground(kind: "semantic") {
          guard AXUIElementPerformAction(element, kAXPressAction as CFString) == .success else {
            throw RPCError(.failed, "This menu item could not be pressed. Use its keyboard shortcut instead.")
          }
        }
        return "Pressed menu [\(line.index)] \(line.content)."
      }
    }
    guard context.window != nil else { throw RPCError(.stale, "There is no screenshot window for mouse input. Use press_key or an accessible menu element.") }
    guard let target = try target(context, params, required: true) else { return "" }
    try context.mouse(kind: "click", point: target.point) { window in
      try Input.click(at: target.point, button: button, count: count, flags: flags, window: window, check: context.check)
    }
    let what = target.element.map { "[\($0.1.index)] \($0.1.content)" } ?? "the point"
    return "Clicked \(what) (\(button.rawValue), \(count)x)."
  }

  func typeText(_ context: ActionContext, _ params: JSONValue) throws -> String {
    try context.check()
    guard let text = params["text"]?.stringValue else { throw RPCError(.invalid, "text is required") }
    if let index = params["element"]?.intValue {
      let (element, _) = try element(context, index)
      let focused = AXUIElementSetAttributeValue(element, kAXFocusedAttribute as CFString, kCFBooleanTrue)
      Thread.sleep(forTimeInterval: 0.1)
      let current: AXUIElement? = AXReader.copy(AXReader.appElement(context.pid), kAXFocusedUIElementAttribute as String)
      if focused != .success || current.map({ !CFEqual($0, element) }) != false {
        try context.inForeground(kind: "semantic") {
          guard AXUIElementSetAttributeValue(element, kAXFocusedAttribute as CFString, kCFBooleanTrue) == .success else {
            throw RPCError(.failed, "Could not focus the requested text element; no text was sent.")
          }
          let actual: AXUIElement? = AXReader.copy(AXReader.appElement(context.pid), kAXFocusedUIElementAttribute as String)
          guard actual.map({ CFEqual($0, element) }) == true else {
            throw RPCError(.failed, "The requested text element did not receive focus; no text was sent.")
          }
          try Input.type(text, pid: context.pid, check: context.check)
        }
        return "Typed \(text.count) characters."
      }
    }
    context.notice("dispatched", "semantic", nil, false)
    try Input.type(text, pid: context.pid, check: context.check)
    return "Typed \(text.count) characters."
  }

  func pressKey(_ context: ActionContext, _ params: JSONValue) throws -> String {
    let keyText = try string(params, "key")
    let combo = try Keys.parse(keyText)
    let times = min(max(params["repeat"]?.intValue ?? 1, 1), 50)
    let send = {
      for _ in 0..<times {
        try Input.key(combo, pid: context.pid, check: context.check)
        Thread.sleep(forTimeInterval: 0.03)
      }
    }
    // 没有窗口接收按键时，让应用菜单处理快捷键；仍走空闲等待与焦点恢复，不直接抢前台。
    if context.window == nil { try context.inForeground(kind: "semantic", send) }
    else { try send() }
    return "Pressed \(keyText)\(times > 1 ? " \(times) times" : "")."
  }

  func scroll(_ context: ActionContext, _ params: JSONValue) throws -> String {
    let direction = params["direction"]?.stringValue ?? "down"
    let amount = min(max(params["amount"]?.intValue ?? 5, 1), 50)
    let point: CGPoint
    if let found = try target(context, params, required: false) {
      point = found.point
    } else {
      guard let window = AXReader.keyWindow(AXReader.appElement(context.pid)),
        let frame = AXReader.frame(of: window)
      else { throw RPCError(.notFound, "The app has no window.") }
      point = CGPoint(x: frame.center.x, y: frame.center.y)
    }
    let lines: Int32 = 3
    let delta: (Int32, Int32)
    switch direction {
    case "up": delta = (0, lines)
    case "down": delta = (0, -lines)
    case "left": delta = (lines, 0)
    case "right": delta = (-lines, 0)
    default: throw RPCError(.invalid, "direction must be up, down, left or right")
    }
    try context.mouse(kind: "scroll", point: point) { window in
      try Input.scroll(at: point, dx: delta.0, dy: delta.1, steps: amount, window: window, check: context.check)
    }
    return "Scrolled \(direction) by \(amount)."
  }

  func setValue(_ context: ActionContext, _ params: JSONValue) throws -> String {
    try context.check()
    guard let index = params["element"]?.intValue else {
      throw RPCError(.invalid, "element is required")
    }
    guard let value = params["value"]?.stringValue else {
      throw RPCError(.invalid, "value is required")
    }
    let (element, line) = try element(context, index)
    var settable: DarwinBoolean = false
    AXUIElementIsAttributeSettable(element, kAXValueAttribute as CFString, &settable)
    guard settable.boolValue else {
      throw RPCError(
        .invalid,
        "[\(index)] does not accept a value. Click it and use type_text, or use another element.")
    }
    var result = AXUIElementSetAttributeValue(
      element, kAXValueAttribute as CFString, value as CFString)
    if result != .success, let number = Double(value) {
      result = AXUIElementSetAttributeValue(
        element, kAXValueAttribute as CFString, NSNumber(value: number))
    }
    guard result == .success else {
      throw RPCError(.failed, "Setting the value of [\(index)] failed (AX error \(result.rawValue)).")
    }
    return "Set the value of [\(index)] \(line.content)."
  }

  func drag(_ context: ActionContext, _ params: JSONValue) throws -> String {
    guard let from = try target(context, params, prefix: "from_", required: true),
      let to = try target(context, params, prefix: "to_", required: true)
    else { return "" }
    try context.mouse(kind: "drag", point: from.point) { _ in
      try Input.drag(from: from.point, to: to.point, check: context.check)
    }
    return "Dragged."
  }

  func selectText(_ context: ActionContext, _ params: JSONValue) throws -> String {
    try context.check()
    guard let index = params["element"]?.intValue else {
      throw RPCError(.invalid, "element is required")
    }
    let (element, _) = try element(context, index)
    var range: CFRange
    if let text = params["text"]?.stringValue {
      let value: String = AXReader.copy(element, kAXValueAttribute as String) ?? ""
      let found = (value as NSString).range(of: text)
      guard found.location != NSNotFound else {
        throw RPCError(.invalid, "\"\(text)\" is not in the text of [\(index)].")
      }
      range = CFRange(location: found.location, length: found.length)
    } else {
      let start = params["start"]?.intValue ?? 0
      let length = params["length"]?.intValue ?? 0
      guard start >= 0, length >= 0 else { throw RPCError(.invalid, "start and length must be >= 0") }
      range = CFRange(location: start, length: length)
    }
    AXUIElementSetAttributeValue(element, kAXFocusedAttribute as CFString, kCFBooleanTrue)
    guard let value = AXValueCreate(.cfRange, &range),
      AXUIElementSetAttributeValue(element, kAXSelectedTextRangeAttribute as CFString, value)
        == .success
    else {
      throw RPCError(
        .failed, "[\(index)] does not support selecting text. Try a drag or shift+arrow keys.")
    }
    return "Selected \(range.length) characters in [\(index)]."
  }
}
