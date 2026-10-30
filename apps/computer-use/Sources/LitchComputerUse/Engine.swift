// 一条连接的请求处理：握手、权限、列应用、取状态，以及每个会话、每个应用的状态（编号、截图的坐标系、停了哪些）。
// 动作本身在 Actions.swift。
//
// 方法（参数和结果的形状和主进程的 apps/desktop/src/computer-use/wire.mts 一致）：
//   hello          {protocol, token?, lang?}            → {protocol, pid, version, bundleId, auth, teamId}
//   diagnostics    {}                                   → 进程号、父进程、责任进程、签名
//   permissions    {}                                   → {accessibility, screenRecording}
//   openSettings   {pane: accessibility|screenRecording} → {opened}（没给过的先向系统申请，见 Apps.swift）
//   setLanguage    {lang}
//   listApps       {}                                   → {apps: [...]}
//   getAppState    {session, app, full?}                → {app, window, screenshot, text, diff, truncated}
//   click / typeText / pressKey / scroll / setValue / drag / selectText  → {text}
//   turnEnded      {session, turnId?}（不给回合号时撤销整个会话）
//   shutdown       {}
// 助手发给主进程的通知：stopped {session, app, bundleId}（用户按了停止）
import AppKit
import ApplicationServices
import Foundation
import LitchComputerUseCore

/// 一个会话里一个应用的状态
struct AppSession {
  var pid: pid_t?
  var launchedAt: Date?
  var book = AXIndexBook()
  /// 最近一次读树时的系统对象
  var handles: [AXUIElement] = []
  /// 最近一次读树时各编号对应的行
  var lines: [Int: AXLine] = [:]
  /// 最近一次截图：截图像素大小、截图里窗口在屏幕上的位置、当时辅助功能报的窗口位置
  var shot: (image: Size, windowFrame: Rect, axFrame: Rect, windowID: CGWindowID)?
}

final class Engine: ConnectionHandler {
  weak var connection: Connection?
  let mode: PeerAuth.Mode
  let ownTeam: String?
  private let lock = NSLock()
  private var apps: [String: [String: AppSession]] = [:]
  private var stopped: [String: Set<String>] = [:]
  private var cancelled: Set<String> = []
  private var endedTurns: Set<String> = []
  private var turns: [String: String] = [:]
  private var epochs: [String: Int] = [:]
  let preview: PreviewHub

  init(connection: Connection, mode: PeerAuth.Mode, ownTeam: String?) {
    self.connection = connection
    self.mode = mode
    self.ownTeam = ownTeam
    self.preview = PreviewHub { [weak connection] value in
      connection?.send(RPC.notification("automation", value))
    }
  }

  func handle(method: String, params: JSONValue) throws -> JSONValue {
    if method == "hello" { return try hello(params) }
    guard connection?.authenticated == true else {
      throw RPCError(.unauthorized, "say hello first")
    }
    switch method {
    case "backgroundCapabilities": return ["mouse": .string(BackgroundMouse.status), "sipEnabledVerified": false]
    case "cancelAction":
      lock.lock(); cancelled.insert(params["actionId"]?.stringValue ?? ""); lock.unlock()
      return [:]
    case "previewSubscribe": preview.subscribe(try string(params, "session")); return [:]
    case "previewPin":
      let session = try string(params, "session")
      preview.floating.onStop = { [weak self] in
        self?.userStopped(session: session, appKey: "*", name: "Computer Use")
        if let self { Activity.shared.end(engine: self, session: session) }
      }
      preview.pin(session); return [:]
    case "previewUnpin": preview.unpin(); return [:]
    case "previewHide": preview.hide(try string(params, "session")); return [:]
    case "previewAck":
      preview.ack(session: try string(params, "session"), token: try string(params, "streamId"), seq: params["seq"]?.intValue ?? -1)
      return [:]
    case "stopSession", "takeover":
      let session = try string(params, "session")
      let target = preview.target(session)
      lock.lock(); stopped[session, default: []].insert("*"); epochs[session, default: 0] += 1; lock.unlock()
      InputOwnership.shared.end(prefix: ownerPrefix(session))
      preview.end(session)
      Activity.shared.end(engine: self, session: session)
      // 接管是用户明确请求；先撤输入所有权，随后才可激活窗口。
      if method == "takeover", let (app, window) = target {
        try InputOwnership.shared.waitUntilIdle()
        try Apps.activate(app, window: window)
      }
      return [:]
    case "diagnostics": return Diagnostics.collect()
    case "permissions": return Permissions.status()
    case "openSettings":
      let pane = params["pane"]?.stringValue ?? ""
      guard let url = Permissions.settingsURL(pane) else {
        throw RPCError(.invalid, "unknown pane")
      }
      // 先申请再打开那一页：申请过列表里才有“Litch Computer Use”（见 Apps.swift 开头）
      let opened = DispatchQueue.main.sync {
        Permissions.request(pane)
        return NSWorkspace.shared.open(url)
      }
      return ["opened": .bool(opened)]
    case "setLanguage":
      Overlay.shared.setLanguage(Copy.language(params["lang"]?.stringValue))
      preview.floating.setLanguage(Copy.language(params["lang"]?.stringValue))
      return [:]
    case "listApps": return ["apps": .array(Apps.list().map(\.json))]
    case "getAppState": return try getAppState(params)
    case "click": return try act(params) { try self.click($0, $1) }
    case "typeText": return try act(params) { try self.typeText($0, $1) }
    case "pressKey": return try act(params) { try self.pressKey($0, $1) }
    case "scroll": return try act(params) { try self.scroll($0, $1) }
    case "setValue": return try act(params) { try self.setValue($0, $1) }
    case "drag": return try act(params) { try self.drag($0, $1) }
    case "selectText": return try act(params) { try self.selectText($0, $1) }
    case "turnEnded":
      let session = try string(params, "session")
      lock.lock()
      let turn = params["turnId"]?.stringValue ?? turns[session] ?? ""
      endedTurns.insert("\(session)|\(turn)")
      // 结束通知可先于队列中的首个动作到达；旧回合的迟到通知也不能撤掉新回合。
      if let current = turns[session], current != turn { lock.unlock(); return [:] }
      epochs[session, default: 0] += 1
      apps[session] = nil
      stopped[session] = nil
      InputOwnership.shared.end(prefix: ownerPrefix(session))
      preview.end(session)
      Activity.shared.end(engine: self, session: session)
      lock.unlock()
      return [:]
    case "shutdown":
      Log.write("主进程要求退出")
      DispatchQueue.global().asyncAfter(deadline: .now() + 0.2) { exit(0) }
      return [:]
    default:
      throw RPCError(.invalid, "unknown method \(method)")
    }
  }

  func closed() {
    InputOwnership.shared.end(prefix: "\(ObjectIdentifier(self))|")
    preview.close()
    Activity.shared.endAll(engine: self)
  }

  // MARK: 握手

  private func hello(_ params: JSONValue) throws -> JSONValue {
    guard let connection else { throw RPCError(.unauthorized, "closed") }
    guard params["protocol"]?.intValue == Wire.protocolVersion else {
      throw RPCError(
        .unauthorized,
        "protocol mismatch: helper speaks \(Wire.protocolVersion), client sent \(params["protocol"].map { "\($0)" } ?? "nothing")"
      )
    }
    let peer = PeerVerifier.peer(fd: connection.fd, team: ownTeam)
    if let reason = PeerAuth.check(
      mode: mode, ownUid: getuid(), peer: peer, offeredToken: params["token"]?.stringValue)
    {
      Log.write(
        "连接 #\(connection.id) 没通过校验：\(reason)（对面 团队=\(peer.teamId ?? "无") 标识=\(peer.identifier ?? "无")）")
      throw RPCError(.unauthorized, reason)
    }
    connection.authenticated = true
    Overlay.shared.setLanguage(Copy.language(params["lang"]?.stringValue))
    preview.floating.setLanguage(Copy.language(params["lang"]?.stringValue))
    let auth: String
    switch mode {
    case .team: auth = "team"
    case .token: auth = "token"
    case .closed: auth = "closed"
    }
    Log.write("连接 #\(connection.id) 握手成功（\(auth)，对面 \(peer.identifier ?? "未签名")）")
    return [
      "protocol": .int(Wire.protocolVersion),
      "pid": .int(Int(getpid())),
      "version": .optional(Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String),
      "bundleId": .optional(Bundle.main.bundleIdentifier),
      "bundlePath": .string(Bundle.main.bundlePath),
      "auth": .string(auth),
      "teamId": .optional(ownTeam),
    ]
  }

  // MARK: 会话状态

  static func appKey(_ app: NSRunningApplication) -> String {
    app.bundleIdentifier ?? "pid:\(app.processIdentifier)"
  }

  static func name(_ app: NSRunningApplication) -> String {
    app.localizedName ?? app.bundleIdentifier ?? "pid \(app.processIdentifier)"
  }

  func withState<T>(_ session: String, _ key: String, _ body: (inout AppSession) throws -> T) rethrows
    -> T
  {
    lock.lock()
    defer { lock.unlock() }
    var state = apps[session]?[key] ?? AppSession()
    defer { apps[session, default: [:]][key] = state }
    return try body(&state)
  }

  /// 用户按了停止（屏幕提示那边调）
  func userStopped(session: String, appKey: String, name: String) {
    lock.lock()
    stopped[session, default: []].insert(appKey)
    epochs[session, default: 0] += 1
    lock.unlock()
    InputOwnership.shared.end(prefix: ownerPrefix(session))
    preview.end(session)
    connection?.send(
      RPC.notification(
        "stopped",
        ["session": .string(session), "app": .string(name), "bundleId": .string(appKey)]))
  }

  /// 动作和取状态之前的共同检查：找应用、停没停、权限
  func prepare(_ params: JSONValue) throws -> (session: String, app: NSRunningApplication, key: String) {
    let session = try string(params, "session")
    let turn = params["turnId"]?.stringValue ?? ""
    lock.lock()
    let alreadyEnded = endedTurns.contains("\(session)|\(turn)")
    lock.unlock()
    guard !alreadyEnded else { throw RPCError(.stopped, "This turn ended. Do not retry actions from this turn.") }
    let app = try Apps.resolve(try string(params, "app"))
    let key = Engine.appKey(app)
    lock.lock()
    let ended = endedTurns.contains("\(session)|\(turn)")
    if !ended, turns[session] != turn { stopped[session] = nil; turns[session] = turn; preview.resume(session) }
    let isStopped = stopped[session]?.contains(key) == true || stopped[session]?.contains("*") == true || ended
    lock.unlock()
    if isStopped {
      throw RPCError(
        .stopped,
        "The user stopped you from controlling \(Engine.name(app)) for the rest of this turn. Do not try again in this turn; summarize what you did and what is left."
      )
    }
    try Permissions.require()
    try Engine.requireDesktop()
    withState(session, key) { state in
      if state.pid != app.processIdentifier || state.launchedAt != app.launchDate {
        state = AppSession(); state.pid = app.processIdentifier; state.launchedAt = app.launchDate
      }
    }
    lock.lock()
    defer { lock.unlock() }
    guard !endedTurns.contains("\(session)|\(turn)"), connection?.isOpen == true else {
      throw RPCError(.stopped, "This turn ended. Do not retry actions from this turn.")
    }
    Activity.shared.begin(engine: self, session: session, appKey: key, name: Engine.name(app))
    return (session, app, key)
  }

  func ownerPrefix(_ session: String) -> String { "\(ObjectIdentifier(self))|\(session)|" }
  static func requireDesktop() throws {
    let blocked = ["com.apple.loginwindow", "com.apple.SecurityAgent", "com.apple.UserNotificationCenter"]
    if let front = NSWorkspace.shared.frontmostApplication?.bundleIdentifier, blocked.contains(front) {
      throw RPCError(.userActive, "A macOS login or permission dialog is in front. The user must finish it before Computer Use can continue.")
    }
  }
  func actionEpoch(_ session: String) -> Int { lock.lock(); defer { lock.unlock() }; return epochs[session] ?? 0 }
  func actionAllowed(_ id: String, session: String, epoch: Int) -> Bool {
    lock.lock(); defer { lock.unlock() }
    return !cancelled.contains(id) && (epochs[session] ?? 0) == epoch && connection?.isOpen == true
  }

  // MARK: 取状态

  private func getAppState(_ params: JSONValue) throws -> JSONValue {
    let epoch = actionEpoch(params["session"]?.stringValue ?? "")
    let (session, app, key) = try prepare(params)
    let full = params["full"]?.boolValue == true
    let pid = app.processIdentifier
    var read: AXReader.Result
    var shot: Screenshot
    preview.status(session: session, app: app, state: "capturePending")
    Overlay.shared.captureNotice(true)
    defer { Overlay.shared.captureNotice(false) }
    do {
      read = try AXReader().read(pid: pid)
      shot = try Capture.window(pid: pid, axFrame: read.windowFrame)
    } catch {
      let failure = CaptureAccess.error(error)
      preview.status(session: session, app: app, state: failure.kind.rawValue)
      throw failure
    }
    guard actionAllowed(params["actionId"]?.stringValue ?? "", session: session, epoch: epoch) else {
      throw RPCError(.stopped, "Observation cancelled.")
    }
    do { try Engine.requireDesktop() } catch {
      _ = CaptureAccess.begin()
      preview.status(session: session, app: app, state: "capturePending")
      throw CaptureAccess.pendingError
    }
    let (text, isDiff) = withState(session, key) { state -> (String, Bool) in
      let lines = state.book.lines(for: read.root)
      let diff = full ? nil : AXText.diff(previous: state.book.previous, current: lines)
      state.book.remember(lines)
      state.handles = read.handles
      state.lines = Dictionary(lines.map { ($0.index, $0) }, uniquingKeysWith: { a, _ in a })
      state.shot = (shot.size, shot.windowFrame, read.windowFrame, shot.windowID)
      return (diff ?? AXText.render(lines), diff != nil)
    }
    preview.observe(session: session, app: app)
    preview.status(session: session, app: app, state: "ready")
    return [
      "app": [
        "name": .string(Engine.name(app)), "bundleId": .optional(app.bundleIdentifier),
        "pid": .int(Int(pid)),
      ],
      "window": [
        "title": .optional(read.windowTitle),
        "width": .number(read.windowFrame.size.width),
        "height": .number(read.windowFrame.size.height),
      ],
      "screenshot": [
        "mime": .string(shot.mime), "data": .string(shot.data.base64EncodedString()),
        "width": .int(Int(shot.size.width)), "height": .int(Int(shot.size.height)),
      ],
      "text": .string(text),
      "diff": .bool(isDiff),
      "truncated": .bool(read.truncated),
    ]
  }

  // MARK: 参数

  func string(_ params: JSONValue, _ key: String) throws -> String {
    guard let value = params[key]?.stringValue, !value.isEmpty else {
      throw RPCError(.invalid, "\(key) is required")
    }
    return value
  }
}
