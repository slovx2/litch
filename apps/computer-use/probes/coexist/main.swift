// 专用自有窗口验收：真实产品 ActionContext/Input + 不带产品标记的并发输入。
// Electron 必须隐藏；不请求系统权限、不截图、不访问非夹具的窗口内容。
import AppKit
import ApplicationServices
import LitchComputerUseCore

let env = ProcessInfo.processInfo.environment
guard let root = env["LITCH_CU_COEXIST_DIR"], root.hasPrefix("/tmp/litch-cu-") else { fatalError("隔离目录必填") }
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
Overlay.shared.installMonitors()
BackgroundMouse.startSelfTest()
let safety = NSLock()
var interrupted = false
var interruption = ""
var simulators: Set<pid_t> = []
var checks: [[String: Any]] = []
let watch = NSEvent.addGlobalMonitorForEvents(matching: [.keyDown, .leftMouseDown, .rightMouseDown, .mouseMoved, .scrollWheel]) { event in
  let marker = event.cgEvent?.getIntegerValueField(.eventSourceUserData)
  if marker == Input.marker || marker == ProbeInput.marker { return }
  if let source = event.cgEvent?.getIntegerValueField(.eventSourceUnixProcessID),
    safety.withLock({ simulators.contains(pid_t(source)) }) { return }
  if event.type == .mouseMoved,
    event.cgEvent?.getIntegerValueField(.mouseEventDeltaX) == 0,
    event.cgEvent?.getIntegerValueField(.mouseEventDeltaY) == 0 { return }
  safety.withLock {
    interrupted = true
    interruption = "eventType=\(event.type.rawValue), sourcePid=\(event.cgEvent?.getIntegerValueField(.eventSourceUnixProcessID) ?? -1)"
  }
}
func safe() throws {
  let reason = safety.withLock { interrupted ? interruption : nil }
  if let reason { throw RPCError(.stopped, "监视到非测试输入，验收让行：" + reason) }
}
func read(_ name: String) throws -> [String: Any] {
  try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: root + "/" + name + "/state.json"))) as! [String: Any]
}
func command(_ name: String, _ action: String) throws {
  try safe()
  let id = UUID().uuidString
  try JSONSerialization.data(withJSONObject: ["id": id, "action": action]).write(to: URL(fileURLWithPath: root + "/" + name + "/command.json"), options: .atomic)
  for _ in 0..<100 {
    if try read(name)["commandID"] as? String == id { Thread.sleep(forTimeInterval: 0.1); return }
    Thread.sleep(forTimeInterval: 0.02)
  }
  throw RPCError(.failed, "夹具命令超时")
}
func running(_ name: String) throws -> NSRunningApplication {
  let value = try read(name)
  guard let pid = value["pid"] as? Int32, let app = NSRunningApplication(processIdentifier: pid),
    ["io.github.slovx2.litch.background-fixture", "io.github.slovx2.litch.background-guard", "com.github.Electron"].contains(app.bundleIdentifier ?? "") else { throw RPCError(.failed, "不是本轮夹具") }
  return app
}
func context(_ target: NSRunningApplication) throws -> ActionContext {
  let c = ActionContext(session: "coexist", app: target, key: "fixture", actionId: UUID().uuidString,
    check: safe, notice: { _, _, _, _ in })
  c.window = try NativeWindow.resolve(target.processIdentifier)
  return c
}
func assertTest(_ ok: Bool, _ name: String) throws {
  checks.append(["test": name, "passed": ok])
  if !ok { throw RPCError(.failed, name) }
}
func point(_ name: String, _ key: String) throws -> CGPoint {
  let value = try read(name)["points"] as! [String: [String: Double]]
  return CGPoint(x: value[key]!["x"]!, y: value[key]!["y"]!)
}
func simulatedKey(_ pid: pid_t) throws {
  try safe()
  guard NSWorkspace.shared.frontmostApplication?.processIdentifier == pid else { throw RPCError(.stopped, "模拟键盘只发给当前自有守卫") }
  try peek(["press", "a", "--foreground", "--input-strategy", "synthOnly"])
}
@Sendable func peek(_ args: [String]) throws {
  guard let path = env["LITCH_CU_PEEKABOO"] else { throw RPCError(.failed, "需要已授权 Peekaboo 的绝对路径") }
  try safe()
  let process = Process()
  process.executableURL = URL(fileURLWithPath: path)
  process.arguments = args + ["--no-remote", "--json"]
  let output = Pipe()
  process.standardOutput = output
  process.standardError = output
  try process.run()
  safety.withLock { _ = simulators.insert(process.processIdentifier) }
  let data = output.fileHandleForReading.readDataToEndOfFile()
  process.waitUntilExit()
  if process.terminationStatus != 0 {
    throw RPCError(.failed, "Peekaboo: " + (String(data: data, encoding: .utf8) ?? "failed"))
  }
}
func simulatedMove(_ pid: pid_t) throws {
  try safe()
  let p = try point("guard", "text")
  try peek(["move", "--at", "\(Int(p.x)),\(Int(p.y))", "--global", "--foreground", "--no-auto-focus"])
}
func simulatedClick(_ c: ActionContext) throws {
  try safe()
  guard NSWorkspace.shared.frontmostApplication?.processIdentifier == c.pid else { throw RPCError(.stopped, "模拟点击只发给当前自有目标") }
  let p = try point("appkit", "text")
  try peek(["click", "--at", "\(Int(p.x)),\(Int(p.y))", "--global", "--foreground", "--input-strategy", "synthOnly"])
}
DispatchQueue.global().async {
  do {
    let accessibility = AXIsProcessTrusted(), postEvent = CGPreflightPostEventAccess()
    checks.append(["accessibility": accessibility, "postEvent": postEvent])
    // 产品的定向输入依赖辅助功能授权；全局 HID 模拟只交给已经获授权的 Peekaboo。
    // PostEvent 预检单列报告，不能把它当作 postToPid 是否实际生效的证据。
    guard accessibility else { throw RPCError(.permission, "专用探针缺辅助功能权限；没有发送输入") }
    let target = try running("appkit"), guardApp = try running("guard")
    // 真实事件监视确认两秒无人操作；系统按事件类型的闲置计时包含自测和零位移鼠标回声。
    Thread.sleep(forTimeInterval: 2)
    try safe()
    guard !UserActivity.hasHeldInput else { throw RPCError(.stopped, "检测到按住的用户输入，未激活测试窗口") }
    try BackgroundMouse.waitForSelfTest(check: safe)
    try command("appkit", "activate")
    try command("guard", "activate")
    try command("appkit", "reset")
    let c = try context(target)
    let initialCursor = CGEvent(source: nil)?.location
    for _ in 0..<10 {
      try simulatedKey(guardApp.processIdentifier)
      try Input.type("中a", pid: c.pid, check: c.check)
    }
    Thread.sleep(forTimeInterval: 0.25)
    try assertTest(try read("appkit")["text"] as? String == String(repeating: "中a", count: 10), "AppKit background text with other-app input")
    checks.append(["monitorRevision": UserActivity.revision,
      "guardRevision": UserActivity.targetRevision(pid: guardApp.processIdentifier),
      "targetRevision": UserActivity.targetRevision(pid: target.processIdentifier),
      "guardCharacters": (try read("guard")["text"] as? String ?? "").count])
    try assertTest(UserActivity.targetRevision(pid: guardApp.processIdentifier) >= 10, "real monitor observed simulated other-app keys")
    try assertTest(NSWorkspace.shared.frontmostApplication?.processIdentifier == guardApp.processIdentifier && CGEvent(source: nil)?.location == initialCursor, "background preserves foreground and cursor")
    // 同一应用被打开查看和滚动也不冲突；后台动作无需活动闸。
    try command("appkit", "activate")
    try Input.type("b", pid: c.pid, check: c.check)
    try command("guard", "activate")
    try c.inForeground(kind: "semantic") {
      for _ in 0..<5 { try simulatedMove(guardApp.processIdentifier); try Input.type("f", pid: c.pid, check: c.check) }
    }
    try assertTest(NSWorkspace.shared.frontmostApplication?.processIdentifier == guardApp.processIdentifier, "foreground fallback allows movement and restores focus")
    var collided = false
    do {
      try c.inForeground(kind: "semantic") { try simulatedClick(c); try c.check() }
    } catch let error as RPCError {
      checks.append(["collisionResult": error.message])
      if error.kind != .userActive { throw error }
      collided = error.message.contains("retry")
    }
    checks.append(["test": "target click fails only current foreground step", "passed": collided,
      "targetRevision": UserActivity.targetRevision(pid: target.processIdentifier), "monitorRevision": UserActivity.revision])
    try command("guard", "activate")
    try c.inForeground(kind: "semantic") { try Input.type("retry", pid: c.pid, check: c.check) }
    try assertTest(try (read("appkit")["text"] as? String ?? "").contains("retry"), "next action retries after collision")
    // 隐藏 Electron：直接核对公开 postToPid 的控件结果，绝不把隐藏窗口激活。
    let electron = try running("electron")
    try command("electron", "reset")
    try command("electron", "focusText")
    try Input.type("abc中文", pid: electron.processIdentifier, check: safe)
    Thread.sleep(forTimeInterval: 0.3)
    checks.append(["test": "hidden Electron public text", "text": try read("electron")["text"] ?? "", "active": try read("electron")["active"] ?? false])
    let state = try read("electron")
    let raw = state["frame"] as! [String: Double]
    let frame = CGRect(x: raw["x"]!, y: raw["y"]!, width: raw["width"]!, height: raw["height"]!)
    let window = (state["windowId"] as! NSNumber).uint32Value
    for backend in ["public", "public-window", "public-nsevent"] {
      for _ in 0..<3 {
        try safe()
        let before = try read("electron")["clicks"] as? Int ?? 0
        for event in try ProbeInput.events(action: "click", point: point("electron", "button"), window: window, frame: frame, backend: backend) {
          try ProbeInput.send(event, pid: electron.processIdentifier, window: window, backend: backend, frame: frame, mouse: true)
        }
        Thread.sleep(forTimeInterval: 0.2)
        checks.append(["test": "hidden Electron click", "backend": backend, "changed": (try read("electron")["clicks"] as? Int ?? 0) == before + 1])
      }
    }
  } catch { checks.append(["error": String(describing: error)]) }
  if let data = try? JSONSerialization.data(withJSONObject: checks, options: [.prettyPrinted, .sortedKeys]) {
    try? data.write(to: URL(fileURLWithPath: root + "/result.json"), options: .atomic)
  }
  DispatchQueue.main.async { NSApp.terminate(nil) }
}
app.run()
