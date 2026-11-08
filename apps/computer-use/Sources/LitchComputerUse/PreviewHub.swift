// 一条已认证助手连接的 surface/预览状态。只有显式订阅的一扇窗口建流，控制端关闭视图即停流。
import AppKit
import LitchComputerUseCore

final class PreviewHub {
  private struct Entry {
    var app: NSRunningApplication
    var window: NativeWindow
    var generation: Int
    var seq = 0
    var point: CGPoint?
    var kind = "semantic"
    var actionId = ""
  }
  private let lock = NSRecursiveLock()
  private var entries: [String: Entry] = [:]
  private var ended: Set<String> = []
  private var generation = 0
  private var selected: String?
  private var observing: Set<String> = []
  private var stream: PreviewStream?
  private var streamID = ""
  private var pinned: String?
  let floating = FloatingPreview()
  let emit: (JSONValue) -> Void

  init(emit: @escaping (JSONValue) -> Void) {
    self.emit = emit
    floating.onClose = { [weak self] in self?.unpin() }
  }

  func status(session: String, app: NSRunningApplication, state: String) {
    lock.lock(); defer { lock.unlock() }
    guard !ended.contains(session) else { return }
    if pinned == session { floating.state(state) }
    emit(["event": "status", "session": .string(session), "app": .string(Engine.name(app)), "status": .string(state)])
  }

  func pin(_ session: String) {
    lock.lock(); defer { lock.unlock() }
    guard let entry = entries[session] else { return }
    pinned = session
    emit(["event": "pin", "session": .string(session), "pinned": true])
    floating.show(title: Engine.name(entry.app))
    selected = session
    start(session)
  }

  func target(_ session: String) -> (NSRunningApplication, AXUIElement)? {
    lock.lock(); defer { lock.unlock() }
    guard let entry = entries[session], !entry.app.isTerminated else { return nil }
    return (entry.app, entry.window.element)
  }

  func unpin() {
    lock.lock(); defer { lock.unlock() }
    let session = pinned; pinned = nil; floating.hide()
    if let session {
      if observing.contains(session) { selected = session; start(session) }
      else { hide(session) }
      emit(["event": "pin", "session": .string(session), "pinned": false])
    }
  }

  private func surface(_ entry: Entry) -> JSONValue {
    ["surfaceId": .string("native:\(entry.window.pid):\(entry.window.id)"),
      "executorId": .string("helper:\(getpid())"), "generation": .int(entry.generation),
      "geometryRevision": .int(entry.generation), "kind": "nativeWindow",
      "width": .number(entry.window.frame.width), "height": .number(entry.window.frame.height)]
  }

  func observe(session: String, app: NSRunningApplication) {
    guard let window = try? NativeWindow.resolve(app.processIdentifier) else { return }
    lock.lock(); defer { lock.unlock() }
    guard !ended.contains(session) else { return }
    let was = entries[session]
    if was?.window.id == window.id, was?.window.pid == window.pid, was?.window.frame == window.frame { return }
    generation += 1
    let entry = Entry(app: app, window: window, generation: generation)
    entries[session] = entry
    emit(["event": "surface", "session": .string(session), "surface": surface(entry),
      "app": .string(Engine.name(app)), "status": "ready", "mouseRoute": .string(BackgroundMouse.status)])
    if selected == session { start(session) }
  }

  func action(session: String, app: NSRunningApplication, actionId: String, state: String,
    kind: String, point: CGPoint?, foreground: Bool) {
    observe(session: session, app: app)
    lock.lock(); defer { lock.unlock() }
    guard var entry = entries[session] else { return }
    entry.seq += 1
    if entry.actionId != actionId { entry.point = nil; entry.kind = kind }
    entry.actionId = actionId
    if let point {
      entry.point = CGPoint(x: point.x - entry.window.frame.minX, y: point.y - entry.window.frame.minY)
      entry.kind = kind
    }
    var sample = surface(entry).objectValue ?? [:]
    sample["actionId"] = .string(actionId); sample["seq"] = .int(entry.seq)
    sample["timeUs"] = .number((ProcessInfo.processInfo.systemUptime * 1_000_000).rounded())
    sample["phase"] = .string(["planned", "dispatched", "completed", "failed", "cancelled"].contains(state) ? state : "planned")
    sample["kind"] = .string(entry.kind)
    sample["pressed"] = .bool(state == "dispatched" && entry.kind == "click")
    if let p = entry.point { sample["position"] = ["x": .number(p.x), "y": .number(p.y)] }
    entries[session] = entry
    if pinned == session {
      floating.point(entry.point, size: entry.window.frame.size, pressed: state == "dispatched")
      floating.state(state, foreground: foreground)
    }
    emit(["event": "pointer", "session": .string(session), "pointer": .object(sample),
      "status": .string(state), "foreground": .bool(foreground || state == "foreground")])
  }

  func subscribe(_ session: String) {
    lock.lock(); defer { lock.unlock() }
    observing.insert(session)
    if let pinned, pinned != session { unpin() }
    selected = session
    start(session)
  }

  private func start(_ session: String) {
    stream?.stop(); stream = nil
    guard let entry = entries[session], selected == session else { return }
    let token = UUID().uuidString
    streamID = token
    let value = PreviewStream(window: entry.window, onFrame: { [weak self] data, width, height, seq in
      guard let self else { return }
      self.lock.lock(); defer { self.lock.unlock() }
      guard self.selected == session, self.streamID == token else { return }
      if self.pinned == session {
        self.floating.frame(data)
        self.stream?.ack(seq)
        return
      }
      self.emit(["event": "frame", "session": .string(session), "surface": self.surface(entry),
        "streamId": .string(token), "seq": .int(seq), "mime": "image/jpeg",
        "data": .string(data.base64EncodedString()), "pixelWidth": .int(width), "pixelHeight": .int(height),
        "contentRect": ["x": 0, "y": 0, "width": .int(width), "height": .int(height)],
        "cursorComposited": false])
    }, onError: { [weak self] reason in
      guard let self else { return }
      self.lock.lock(); defer { self.lock.unlock() }
      guard self.streamID == token, self.selected == session else { return }
      if self.pinned == session { self.floating.state(reason) }
      self.emit(["event": "status", "session": .string(session), "status": .string(reason)])
      // 窗口几何改变时创建新版本/新流；不可见时不把旧帧当成实时画面。
      if reason == "interrupted" { self.observe(session: session, app: entry.app) }
    })
    stream = value
    value.start()
  }

  func ack(session: String, token: String, seq: Int) {
    lock.lock(); defer { lock.unlock() }
    if selected == session, streamID == token { stream?.ack(seq) }
  }

  func hide(_ session: String) {
    lock.lock(); defer { lock.unlock() }
    observing.remove(session)
    if pinned == session { return }
    if selected == session { selected = nil; streamID = ""; stream?.stop(); stream = nil }
  }

  func end(_ session: String) {
    lock.lock(); defer { lock.unlock() }
    ended.insert(session)
    clearWindow(session)
  }

  func clearWindow(_ session: String) {
    lock.lock(); defer { lock.unlock() }
    if pinned == session { pinned = nil; floating.hide() }
    hide(session)
    entries[session] = nil
    emit(["event": "removed", "session": .string(session)])
  }

  func resume(_ session: String) { lock.lock(); ended.remove(session); lock.unlock() }

  func close() {
    lock.lock(); defer { lock.unlock() }
    for session in Array(entries.keys) { end(session) }
  }
}
