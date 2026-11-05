// 操作期间屏幕上方的常驻小提示：正在操作哪个应用、怎么停（Esc 或“停止”按钮）。
// 提示是不抢焦点的浮动面板，所有桌面空间都显示，不进截图（截图只截目标窗口，面板也标了不让别人录）。
//
// 提示显示期间同时监听用户的键鼠（全局监听，要辅助功能权限，动作本来就要这项权限）：
//   - 用户按 Esc：停掉正在操作的全部应用，通知主进程，本回合不再操作它们
//   - 按下键鼠：记录实际目标和按住状态，只用于当前前台动作的冲突判断；查看、移动、滚动不停止任务。
// 我们自己发的事件带标记（Input.marker），不算用户在动。
import AppKit
import Foundation
import LitchComputerUseCore

enum UserActivity {
  private static let lock = NSLock()
  private static var sequence: UInt64 = 0
  private static var state = InputConflict()
  private static var lastAt = Date.distantPast

  // 全局版本仅供修饰键和光标收尾使用，不作为动作冲突判据。
  static var revision: UInt64 { lock.withLock { sequence } }
  static var idleSeconds: TimeInterval { lock.withLock { Date().timeIntervalSince(lastAt) } }
  static func seed() {
    let pid = NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0
    for code in 0..<128 where code != 57 && CGEventSource.keyState(.hidSystemState, key: CGKeyCode(code)) {
      note(.keyDown, pid: pid, code: code)
    }
    for button in [CGMouseButton.left, .right, .center] where CGEventSource.buttonState(.hidSystemState, button: button) {
      note(.mouseDown, pid: pid, code: Int(button.rawValue))
    }
  }
  static func targetRevision(pid: pid_t) -> UInt64 { lock.withLock { state.revision(pid: pid) } }
  static var hasHeldInput: Bool { lock.withLock { state.blocked(background: false) } }
  static var hasHeldPointer: Bool { lock.withLock { state.pointerHeld } }

  /// 公开 AX 属性只查询有没有组字范围，不读取内容；不支持该属性的应用无法据此判断 IME。
  static var isComposing: Bool {
    guard let pid = NSWorkspace.shared.frontmostApplication?.processIdentifier,
      let focus: AXUIElement = AXReader.copy(AXReader.appElement(pid), kAXFocusedUIElementAttribute as String) else { return false }
    var value: CFTypeRef?
    return AXUIElementCopyAttributeValue(focus, "AXTextInputMarkedTextMarkerRange" as CFString, &value) == .success && value != nil
  }

  static func note(_ kind: InputConflict.Kind, pid: pid_t, code: Int = 0) {
    lock.withLock {
      sequence &+= 1
      lastAt = Date()
      state.note(kind, pid: pid, code: code)
    }
  }

  /// 只读取事件归属，不读取其他窗口的文字。鼠标不能按前台 PID 归因：后台窗口也能被点击。
  static func recipient(_ event: NSEvent) -> pid_t {
    // NSEvent 重建的 CGEvent 目标 PID 不保证是原始接收者，不能据此归因。
    // 键盘以接收时的前台应用为准，鼠标用实际命中窗口，均不读窗口内容。
    if [.keyDown, .keyUp, .flagsChanged].contains(event.type) {
      return NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0
    }
    let windowIDs: [Int64] = [
      event.cgEvent?.getIntegerValueField(.mouseEventWindowUnderMousePointerThatCanHandleThisEvent) ?? 0,
      event.cgEvent?.getIntegerValueField(.mouseEventWindowUnderMousePointer) ?? 0,
      Int64(event.windowNumber),
    ]
    if let pid = InputPolicy.mouseRecipient(windowIDs: windowIDs, owner: { id in
      let rows = CGWindowListCopyWindowInfo(.optionIncludingWindow, id) as? [[String: Any]] ?? []
      return rows.first { ($0[kCGWindowNumber as String] as? UInt32) == id }?[kCGWindowOwnerPID as String] as? Int32
    }) { return pid }
    // 没有有效窗口号时才按 AX 命中元素取归属，不能把透明/穿透浮层的矩形当作命中。
    guard let point = event.cgEvent?.location else { return 0 }
    var element: AXUIElement?
    var pid: pid_t = 0
    if AXUIElementCopyElementAtPosition(AXUIElementCreateSystemWide(), Float(point.x), Float(point.y), &element) == .success,
      let element, AXUIElementGetPid(element, &pid) == .success { return pid }
    return 0
  }

}

final class Overlay {
  static let shared = Overlay()

  /// 用户要停（Esc 或按钮）。在主线程上调
  var onStop: (() -> Void)?
  private var language: Copy.Language = .en
  private var names: [String] = []
  private var panel: NSPanel?
  private var titleField: NSTextField?
  private var hintField: NSTextField?
  private var stopButton: NSButton?
  private var monitors: [Any] = []
  private var capturePending = false

  func captureNotice(_ pending: Bool) {
    DispatchQueue.main.async { self.capturePending = pending; self.refresh() }
  }

  func setLanguage(_ language: Copy.Language) {
    DispatchQueue.main.async {
      self.language = language
      self.refresh()
    }
  }

  /// 显示（或更新）正在操作的应用；空表就收起
  func show(_ names: [String]) {
    DispatchQueue.main.async {
      self.names = names
      if names.isEmpty {
        self.panel?.orderOut(nil)
        return
      }
      if self.panel == nil { self.build() }
      self.refresh()
      self.place()
      self.panel?.orderFrontRegardless()
    }
  }

  private func build() {
    let panel = NSPanel(
      contentRect: NSRect(x: 0, y: 0, width: 440, height: 58),
      styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
    panel.level = .statusBar
    panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
    panel.isOpaque = false
    panel.backgroundColor = .clear
    panel.hasShadow = true
    panel.hidesOnDeactivate = false
    panel.isMovableByWindowBackground = true
    panel.sharingType = .none

    let background = NSVisualEffectView()
    background.material = .hudWindow
    background.state = .active
    background.blendingMode = .behindWindow
    background.wantsLayer = true
    background.layer?.cornerRadius = 12
    background.layer?.masksToBounds = true

    let title = NSTextField(labelWithString: "")
    title.font = .systemFont(ofSize: 13, weight: .semibold)
    title.lineBreakMode = .byTruncatingTail
    let hint = NSTextField(labelWithString: "")
    hint.font = .systemFont(ofSize: 11)
    hint.textColor = .secondaryLabelColor
    let texts = NSStackView(views: [title, hint])
    texts.orientation = .vertical
    texts.alignment = .leading
    texts.spacing = 2

    let button = NSButton(title: "", target: self, action: #selector(stopPressed))
    button.bezelStyle = .rounded
    button.controlSize = .regular
    button.keyEquivalent = "\u{1b}"

    let dot = NSView()
    dot.wantsLayer = true
    dot.layer?.backgroundColor = NSColor.systemOrange.cgColor
    dot.layer?.cornerRadius = 5
    dot.translatesAutoresizingMaskIntoConstraints = false
    dot.widthAnchor.constraint(equalToConstant: 10).isActive = true
    dot.heightAnchor.constraint(equalToConstant: 10).isActive = true

    let row = NSStackView(views: [dot, texts, button])
    row.orientation = .horizontal
    row.alignment = .centerY
    row.spacing = 12
    row.edgeInsets = NSEdgeInsets(top: 10, left: 14, bottom: 10, right: 12)
    row.setHuggingPriority(.defaultLow, for: .horizontal)
    texts.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
    row.translatesAutoresizingMaskIntoConstraints = false
    background.addSubview(row)
    NSLayoutConstraint.activate([
      row.leadingAnchor.constraint(equalTo: background.leadingAnchor),
      row.trailingAnchor.constraint(equalTo: background.trailingAnchor),
      row.topAnchor.constraint(equalTo: background.topAnchor),
      row.bottomAnchor.constraint(equalTo: background.bottomAnchor),
    ])
    panel.contentView = background
    self.panel = panel
    titleField = title
    hintField = hint
    stopButton = button
  }

  private func refresh() {
    guard !names.isEmpty else { return }
    titleField?.stringValue = Copy.banner(language, app: Copy.apps(language, names: names))
    hintField?.stringValue = capturePending ? Copy.captureNotice(language) : Copy.hint(language)
    stopButton?.title = Copy.stop(language)
  }

  /// 放在主屏顶部正中、菜单栏下面
  private func place() {
    guard let panel, let screen = NSScreen.screens.first else { return }
    let visible = screen.visibleFrame
    let size = panel.frame.size
    panel.setFrameOrigin(
      NSPoint(x: visible.midX - size.width / 2, y: visible.maxY - size.height - 10))
  }

  @objc private func stopPressed() {
    onStop?()
  }

  func installMonitors() {
    guard monitors.isEmpty else { return }
    UserActivity.seed()
    let mask: NSEvent.EventTypeMask = [
      .keyDown, .keyUp, .leftMouseDown, .leftMouseUp, .rightMouseDown, .rightMouseUp, .otherMouseDown, .otherMouseUp, .scrollWheel, .mouseMoved,
      .leftMouseDragged, .rightMouseDragged, .otherMouseDragged, .flagsChanged,
    ]
    if let global = NSEvent.addGlobalMonitorForEvents(matching: mask, handler: { [weak self] event in
      self?.observe(event)
    }) {
      monitors.append(global)
    }
    if let local = NSEvent.addLocalMonitorForEvents(matching: [.keyDown], handler: { [weak self] event in
      if event.keyCode == 53 {
        self?.onStop?()
        return nil
      }
      return event
    }) {
      monitors.append(local)
    }
  }

  private func removeMonitors() {
    for monitor in monitors { NSEvent.removeMonitor(monitor) }
    monitors.removeAll()
  }

  private func observe(_ event: NSEvent) {
    if event.cgEvent?.getIntegerValueField(.eventSourceUserData) == Input.marker { return }
    if event.type == .keyDown, event.keyCode == 53 {
      onStop?()
      return
    }
    let kind: InputConflict.Kind
    switch event.type {
    case .keyDown: kind = .keyDown
    case .keyUp: kind = .keyUp
    case .flagsChanged:
      if event.keyCode == 57 { return } // Caps Lock 是锁定状态，不是持续按住。
      kind = CGEventSource.keyState(.hidSystemState, key: event.keyCode) ? .keyDown : .keyUp
    case .leftMouseDown, .rightMouseDown, .otherMouseDown: kind = .mouseDown
    case .leftMouseUp, .rightMouseUp, .otherMouseUp: kind = .mouseUp
    case .scrollWheel: kind = .scroll
    default: kind = .move
    }
    // 修饰键的按住状态阻止中途切前台，但仅切应用的修饰键不使目标动作失效。
    UserActivity.note(kind, pid: event.type == .flagsChanged ? 0 : UserActivity.recipient(event),
      code: [.keyDown, .keyUp, .flagsChanged].contains(event.type) ? Int(event.keyCode) : event.buttonNumber)
  }
}
