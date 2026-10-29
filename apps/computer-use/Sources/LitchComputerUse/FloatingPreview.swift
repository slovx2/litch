// 用户固定的非激活画中画。只观看和停止，不把预览坐标变成应用输入。
import AppKit
import LitchComputerUseCore

final class FloatingPreview: NSObject {
  private var panel: NSPanel?
  private let image = PreviewImageView()
  private let cursor = NSTextField(labelWithString: "↖")
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
      self.cursor.frame.origin = CGPoint(x: x, y: y - 24)
      self.cursor.textColor = pressed ? .systemOrange : .controlAccentColor
      self.cursor.isHidden = false
    }
  }
  func hide() { DispatchQueue.main.async { self.panel?.orderOut(nil); self.image.image = nil } }
  private func build() {
    let panel = NSPanel(contentRect: NSRect(x: 80, y: 80, width: 360, height: 270),
      styleMask: [.titled, .nonactivatingPanel, .resizable], backing: .buffered, defer: false)
    panel.title = "Litch"; panel.level = .floating; panel.hidesOnDeactivate = false
    panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]; panel.sharingType = .none
    let root = NSView()
    image.imageScaling = .scaleProportionallyUpOrDown
    image.translatesAutoresizingMaskIntoConstraints = false; root.addSubview(image)
    cursor.font = .systemFont(ofSize: 24, weight: .bold); cursor.frame.size = CGSize(width: 28, height: 28)
    cursor.setAccessibilityElement(false); image.addSubview(cursor)
    let zh = Locale.preferredLanguages.first?.hasPrefix("zh") == true
    let stop = NSButton(title: zh ? "停止" : "Stop", target: self, action: #selector(stopPressed))
    let close = NSButton(title: zh ? "收起" : "Hide", target: self, action: #selector(closePressed))
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

// 图像像素数不能成为 NSPanel 的最小尺寸；实际尺寸完全由面板约束决定。
private final class PreviewImageView: NSImageView {
  override var intrinsicContentSize: NSSize {
    NSSize(width: NSView.noIntrinsicMetric, height: NSView.noIntrinsicMetric)
  }
}
