// 用户固定的非激活画中画。只观看和停止，不把预览坐标变成应用输入。
import AppKit
import QuartzCore
import LitchComputerUseCore

final class FloatingPreview: NSObject {
  /// 全局鼠标投递期间，助手自己的所有浮窗都须穿透，包括其他连接固定的浮窗。
  /// 保留可见画面；否则浮窗覆盖目标坐标时会吞掉点击，目标却收到“成功”。
  static func passThroughDuringInput() -> () -> Void {
    let apply = {
      NSApp.windows.compactMap { $0 as? PreviewPanel }.map { panel in
        let was = panel.ignoresMouseEvents
        panel.ignoresMouseEvents = true
        return (panel, was)
      }
    }
    let previous = Thread.isMainThread ? apply() : DispatchQueue.main.sync(execute: apply)
    return {
      let restore = { for (panel, was) in previous { panel.ignoresMouseEvents = was } }
      if Thread.isMainThread { restore() } else { DispatchQueue.main.sync(execute: restore) }
    }
  }

  private var panel: NSPanel?
  private let image = PreviewImageView()
  private let cursor = PreviewCursorView()
  private let stop = NSButton()
  private let close = NSButton()
  private let label = NSTextField(labelWithString: "")
  private let statusLabel = NSTextField(labelWithString: "")
  private var language: Copy.Language = .en
  private var status = "ready"
  private var usedForeground = false
  var onStop: (() -> Void)?
  var onClose: (() -> Void)?
  private let frameLock = NSLock()
  private var latest: Data?
  private var queued = false

  func setLanguage(_ language: Copy.Language) {
    DispatchQueue.main.async { self.language = language; self.refreshStatus() }
  }

  func state(_ status: String, foreground: Bool = false) {
    DispatchQueue.main.async {
      if self.status == "restoreFailed" && ["completed", "failed"].contains(status) { return }
      self.status = status
      self.usedForeground = self.usedForeground || foreground || status == "foreground"
      self.refreshStatus()
    }
  }

  private func refreshStatus() {
    let zh = language == .zh
    stop.title = zh ? "停止" : "Stop"
    close.title = zh ? "收起" : "Hide"
    switch status {
    case "capturePending": statusLabel.stringValue = zh ? "等待系统允许屏幕采集" : "Waiting for screen capture permission"
    case "captureDenied": statusLabel.stringValue = zh ? "屏幕采集被拒绝或停止" : "Screen capture denied or stopped"
    case "captureFailed", "interrupted": statusLabel.stringValue = zh ? "画面已中断" : "Preview interrupted"
    case "waitingForIdle": statusLabel.stringValue = zh ? "等待键鼠空闲" : "Waiting for idle keyboard and mouse"
    case "restoreFailed": statusLabel.stringValue = zh ? "请手动切回原窗口" : "Please switch back to the previous window"
    default: statusLabel.stringValue = usedForeground
      ? (zh ? "已短暂切到前台" : "Briefly brought to the foreground")
      : (zh ? "后台操作" : "Background operation")
    }
  }

  func show(title: String) {
    DispatchQueue.main.async {
      if self.panel == nil { self.build() }
      self.usedForeground = false; self.status = "ready"; self.refreshStatus()
      self.image.image = nil; self.cursor.isHidden = true
      self.label.stringValue = title
      self.panel?.orderFrontRegardless()
    }
  }
  func frame(_ data: Data) {
    frameLock.lock(); latest = data
    if queued { frameLock.unlock(); return }
    queued = true; frameLock.unlock()
    DispatchQueue.main.async {
      self.frameLock.lock(); let data = self.latest; self.latest = nil; self.queued = false; self.frameLock.unlock()
      if let data { self.image.image = NSImage(data: data) }
    }
  }
  func point(_ point: CGPoint?, size: CGSize, pressed: Bool) {
    DispatchQueue.main.async {
      guard let point, size.width > 0, size.height > 0 else { self.cursor.isHidden = true; return }
      let scale = min(self.image.bounds.width / size.width, self.image.bounds.height / size.height)
      let x = (self.image.bounds.width - size.width * scale) / 2 + point.x * scale
      let y = (self.image.bounds.height - size.height * scale) / 2 + (size.height - point.y) * scale
      self.cursor.frame.origin = CGPoint(x: x - 3, y: y - 30)
      self.cursor.color(pressed ? .systemOrange : .controlAccentColor)
      self.cursor.isHidden = false
    }
  }
  func hide() { DispatchQueue.main.async { self.panel?.orderOut(nil); self.image.image = nil } }
  private func build() {
    let panel = PreviewPanel(contentRect: NSRect(x: 80, y: 80, width: 360, height: 270),
      styleMask: [.titled, .nonactivatingPanel, .resizable], backing: .buffered, defer: false)
    panel.title = "Litch"; panel.level = .floating; panel.hidesOnDeactivate = false
    panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]; panel.sharingType = .none
    let root = NSView()
    image.imageScaling = .scaleProportionallyUpOrDown
    image.translatesAutoresizingMaskIntoConstraints = false; root.addSubview(image)
    cursor.frame.size = CGSize(width: 28, height: 32)
    cursor.setAccessibilityElement(false); image.addSubview(cursor)
    stop.target = self; stop.action = #selector(stopPressed)
    close.target = self; close.action = #selector(closePressed)
    stop.bezelStyle = .rounded; close.bezelStyle = .rounded
    statusLabel.font = .systemFont(ofSize: 11); statusLabel.textColor = .secondaryLabelColor
    label.lineBreakMode = .byTruncatingTail; statusLabel.lineBreakMode = .byTruncatingTail
    let text = NSStackView(views: [label, statusLabel]); text.orientation = .vertical; text.alignment = .leading; text.spacing = 2
    let row = NSStackView(views: [text, stop, close]); row.translatesAutoresizingMaskIntoConstraints = false; row.spacing = 8
    root.addSubview(row)
    NSLayoutConstraint.activate([
      image.leadingAnchor.constraint(equalTo: root.leadingAnchor), image.trailingAnchor.constraint(equalTo: root.trailingAnchor),
      image.topAnchor.constraint(equalTo: root.topAnchor), image.bottomAnchor.constraint(equalTo: row.topAnchor, constant: -6),
      row.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 8), row.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -8),
      row.bottomAnchor.constraint(equalTo: root.bottomAnchor, constant: -8), row.heightAnchor.constraint(equalToConstant: 40),
    ])
    panel.contentView = root; self.panel = panel
  }
  @objc private func stopPressed() { onStop?() }
  @objc private func closePressed() { onClose?() }
}

final class PreviewPanel: NSPanel {}

// 和公共 pointer-renderer 的 28×32 SVG 使用同一轮廓；AppKit 的 y 轴向上。
final class PreviewCursorView: NSView {
  private let shape = CAShapeLayer()
  override init(frame frameRect: NSRect) {
    super.init(frame: frameRect)
    wantsLayer = true
    let path = CGMutablePath()
    let points: [CGPoint] = [.init(x: 3, y: 2), .init(x: 3, y: 23), .init(x: 9, y: 18),
      .init(x: 14, y: 28), .init(x: 18, y: 26), .init(x: 13, y: 16), .init(x: 22, y: 16)]
    for (index, point) in points.enumerated() {
      let transformed = CGPoint(x: point.x, y: 32 - point.y)
      if index == 0 { path.move(to: transformed) } else { path.addLine(to: transformed) }
    }
    path.closeSubpath(); shape.path = path
    shape.strokeColor = NSColor.white.cgColor; shape.lineWidth = 1.4; shape.lineJoin = .round
    shape.fillColor = NSColor.controlAccentColor.cgColor
    layer?.addSublayer(shape)
  }
  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
  func color(_ color: NSColor) { shape.fillColor = color.cgColor }
}

// 图像像素数不能成为 NSPanel 的最小尺寸；实际尺寸完全由面板约束决定。
final class PreviewImageView: NSImageView {
  override var intrinsicContentSize: NSSize {
    NSSize(width: NSView.noIntrinsicMetric, height: NSView.noIntrinsicMetric)
  }
}
