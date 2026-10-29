// 操作期间屏幕上方的常驻小提示：正在操作哪个应用、怎么停（Esc 或“停止”按钮）。
// 提示是不抢焦点的浮动面板，所有桌面空间都显示，不进截图（截图只截目标窗口，面板也标了不让别人录）。
//
// 提示显示期间同时监听用户的键鼠（全局监听，要辅助功能权限，动作本来就要这项权限）：
//   - 用户按 Esc：停掉正在操作的全部应用，通知主进程，本回合不再操作它们
//   - 用户在动键鼠：记下时间和当时在前台的应用。之后一小段时间里对同一个应用的动作被拒，告诉模型等一会儿
// 我们自己发的事件带标记（Input.marker），不算用户在动。
import AppKit
import Foundation
import LitchComputerUseCore

enum UserActivity {
  /// 用户动过键鼠之后多久之内不去动同一个应用
  static let quietSeconds: TimeInterval = 2.0
  private static let lock = NSLock()
  private static var lastAt = Date.distantPast
  private static var lastPid: pid_t = 0
  private static var sequence: UInt64 = 0

  static var revision: UInt64 { lock.lock(); defer { lock.unlock() }; return sequence }
  static var idleSeconds: TimeInterval {
    lock.lock(); defer { lock.unlock() }
    if CGEventSource.buttonState(.combinedSessionState, button: .left) ||
      CGEventSource.buttonState(.combinedSessionState, button: .right) ||
      CGEventSource.flagsState(.combinedSessionState).intersection([.maskShift, .maskControl, .maskAlternate, .maskCommand]).rawValue != 0 { return 0 }
    return Date().timeIntervalSince(lastAt)
  }

  static func seed() {
    let idle = [CGEventType.keyDown, .flagsChanged, .mouseMoved, .leftMouseDown, .rightMouseDown, .scrollWheel]
      .map { CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: $0) }.min() ?? 0
    lock.lock(); lastAt = Date().addingTimeInterval(-idle); lock.unlock()
  }

  static func note(pid: pid_t) {
    lock.lock()
    lastAt = Date()
    lastPid = pid
    sequence += 1
    lock.unlock()
  }

  /// 用户最近是不是在动这个应用
  static func isBusy(pid: pid_t) -> Bool {
    lock.lock()
    defer { lock.unlock() }
    return lastPid == pid && Date().timeIntervalSince(lastAt) < quietSeconds
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
      .keyDown, .leftMouseDown, .rightMouseDown, .otherMouseDown, .scrollWheel, .mouseMoved,
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
    if let front = NSWorkspace.shared.frontmostApplication?.processIdentifier {
      UserActivity.note(pid: front)
    }
  }
}
