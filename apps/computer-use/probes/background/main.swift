// M0 专用驱动：独立应用身份，只访问本轮夹具，不进入产品构建。
import AppKit
import ApplicationServices
import Foundation

let probeArguments = CommandLine.arguments
guard let directoryIndex = probeArguments.firstIndex(of: "--directory"),
  probeArguments.indices.contains(directoryIndex + 1)
else { fatalError("需要 --directory") }
let probeDirectory = URL(fileURLWithPath: probeArguments[directoryIndex + 1], isDirectory: true)
try FileManager.default.createDirectory(at: probeDirectory, withIntermediateDirectories: true,
  attributes: [.posixPermissions: 0o700])
let application = NSApplication.shared
application.setActivationPolicy(.accessory)

@Sendable func writeProbeJSON(_ value: [String: Any], name: String) {
  guard let data = try? JSONSerialization.data(withJSONObject: value, options: [.prettyPrinted, .sortedKeys]) else { return }
  try? data.write(to: probeDirectory.appendingPathComponent(name), options: .atomic)
}

writeProbeJSON(ProbeDiagnostics.collect(), name: "permissions.json")

// 不请求或修改系统授权，由用户在系统设置里为这个专用测试应用授权。
var permissionTimer: Timer? = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { _ in
  writeProbeJSON(ProbeDiagnostics.collect(), name: "permissions.json")
}
var foregroundTimer: Timer? = Timer.scheduledTimer(withTimeInterval: 0.05, repeats: true) { _ in
  writeProbeJSON(["frontPid": NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0,
    "sampledAt": Date().timeIntervalSince1970, "instanceID": ProbeDiagnostics.instanceID], name: "foreground.json")
}
@Sendable func readJSON(_ path: URL) throws -> [String: Any] {
  guard let value = try JSONSerialization.jsonObject(with: Data(contentsOf: path)) as? [String: Any]
  else { throw ProbeFailure.unavailable("not an object") }
  return value
}

@Sendable func fixture(_ name: String) throws -> ([String: Any], URL) {
  guard name.range(of: "^[a-zA-Z0-9_-]+$", options: .regularExpression) != nil else {
    throw ProbeFailure.unavailable("invalid fixture name")
  }
  let path = probeDirectory.appendingPathComponent(name).appendingPathComponent("state.json")
  let state = try readJSON(path)
  guard let pid = state["pid"] as? Int32, let running = NSRunningApplication(processIdentifier: pid),
    ["io.github.slovx2.litch.background-fixture", "io.github.slovx2.litch.background-guard", "com.github.Electron"].contains(running.bundleIdentifier ?? "")
  else { throw ProbeFailure.unavailable("not a running test fixture") }
  return (state, path)
}

@Sendable func windowID(pid: pid_t, frame: CGRect) throws -> UInt32 {
  let windows = CGWindowListCopyWindowInfo(.optionAll, kCGNullWindowID) as? [[String: Any]] ?? []
  let candidates = windows.filter { window in
    guard window[kCGWindowOwnerPID as String] as? Int32 == pid,
      window[kCGWindowLayer as String] as? Int == 0,
      window[kCGWindowIsOnscreen as String] as? Bool == true,
      let raw = window[kCGWindowBounds as String] as? [String: Double]
    else { return false }
    return abs((raw["X"] ?? .infinity) - frame.minX) < 1 &&
      abs((raw["Y"] ?? .infinity) - frame.minY) < 1 &&
      abs((raw["Width"] ?? .infinity) - frame.width) < 1 &&
      abs((raw["Height"] ?? .infinity) - frame.height) < 1
  }
  guard candidates.count == 1, let number = candidates[0][kCGWindowNumber as String] as? UInt32 else {
    throw ProbeFailure.unavailable("expected one visible fixture window, found \(candidates.count)")
  }
  return number
}

@Sendable func sample() -> [String: Any] {
  let cursor = CGEvent(source: nil)?.location ?? .zero
  return ["time": ProcessInfo.processInfo.systemUptime,
    "frontPid": NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0,
    "cursorX": cursor.x, "cursorY": cursor.y]
}

@Sendable func axFocus(pid: pid_t) -> [String: Int32] {
  let target = AXUIElementCreateApplication(pid)
  var raw: CFTypeRef?
  let result = AXUIElementCopyAttributeValue(target, kAXWindowsAttribute as CFString, &raw)
  guard result == .success, let windows = raw as? [AXUIElement], let window = windows.first else {
    return ["readWindows": result.rawValue]
  }
  return [
    "main": AXUIElementSetAttributeValue(window, kAXMainAttribute as CFString, kCFBooleanTrue).rawValue,
    "focused": AXUIElementSetAttributeValue(window, kAXFocusedAttribute as CFString, kCFBooleanTrue).rawValue,
  ]
}

@Sendable func pressFixtureButton(pid: pid_t) throws -> Int32 {
  var pending = [AXUIElementCreateApplication(pid)]
  var visited = 0
  func value(_ element: AXUIElement, _ key: String) -> CFTypeRef? {
    var result: CFTypeRef?
    return AXUIElementCopyAttributeValue(element, key as CFString, &result) == .success ? result : nil
  }
  while let element = pending.popLast(), visited < 500 {
    visited += 1
    if value(element, kAXRoleAttribute) as? String == kAXButtonRole,
      value(element, "AXIdentifier") as? String == "probe-button" ||
      value(element, kAXTitleAttribute) as? String == "计数按钮" ||
      value(element, kAXDescriptionAttribute) as? String == "计数按钮" {
      return AXUIElementPerformAction(element, kAXPressAction as CFString).rawValue
    }
    pending.append(contentsOf: value(element, kAXChildrenAttribute) as? [AXUIElement] ?? [])
  }
  throw ProbeFailure.unavailable("AX fixture button not found")
}

enum ProbeRunner {
@MainActor static func run(_ request: [String: Any]) async -> [String: Any] {
  var output: [String: Any] = ["id": request["id"] ?? "", "request": request,
    "symbols": ProbeInput.capabilities(), "os": ProcessInfo.processInfo.operatingSystemVersionString,
    "permissions": ProbeDiagnostics.collect()]
  var samples: [[String: Any]] = []
  var focusedTarget: (pid_t, UInt32)?
  do {
    guard request["driverInstanceID"] as? String == ProbeDiagnostics.instanceID else {
      throw ProbeFailure.unavailable("stale driver instance; no input posted")
    }
    guard AXIsProcessTrusted(), CGPreflightPostEventAccess() else {
      throw ProbeFailure.unavailable("accessibility permission required; no input posted")
    }
    guard let targetName = request["target"] as? String, let guardName = request["guard"] as? String,
      let backend = request["backend"] as? String, let action = request["action"] as? String,
      ["public", "public-window", "public-ax", "public-nsevent", "public-nsevent-touch", "private-focus", "private-fields", "private-focus-fields", "private-ax-focus-fields", "private", "private-tagged", "private-sky-tagged"].contains(backend)
    else { throw ProbeFailure.unavailable("invalid request") }
    let (target, targetPath) = try fixture(targetName)
    let (foreground, foregroundPath) = try fixture(guardName)
    guard let pid = target["pid"] as? Int32, let guardPid = foreground["pid"] as? Int32,
      pid != guardPid, NSWorkspace.shared.frontmostApplication?.processIdentifier == guardPid,
      let points = target["points"] as? [String: [String: Double]],
      let point = points[action == "click" ? "button" : action == "scroll" ? "scroll" : "text"],
      let x = point["x"], let y = point["y"], let frame = target["frame"] as? [String: Double]
    else { throw ProbeFailure.unavailable("guard not foreground or fixture data incomplete") }
    let rect = CGRect(x: frame["x"] ?? 0, y: frame["y"] ?? 0,
      width: frame["width"] ?? 0, height: frame["height"] ?? 0)
    let window = try windowID(pid: pid, frame: rect)
    output["selectedWindowId"] = window
    output["selectedWindowFrame"] = frame
    output["before"] = target
    output["guardBefore"] = foreground
    samples.append(sample())
    if backend == "public-ax" || backend == "private-ax-focus-fields" { output["axFocus"] = axFocus(pid: pid) }
    if ["private-focus", "private-focus-fields", "private-ax-focus-fields", "private", "private-tagged", "private-sky-tagged"].contains(backend) {
      let status = try ProbeInput.focus(pid: pid, window: window, enabled: true)
      output["focusStatus"] = status
      guard status == 0 else { throw ProbeFailure.unavailable("private focus failed") }
      focusedTarget = (pid, window)
    }
    // 只处理预先指定夹具；采样发现用户把其他应用切到前台便中止，绝不拉回守卫。
    for _ in 0..<25 {
      try await Task.sleep(nanoseconds: 5_000_000)
      samples.append(sample())
    }
    let events: [CGEvent]
    if action == "ax-click" {
      output["axPressStatus"] = try pressFixtureButton(pid: pid)
      events = []
    } else {
      events = try ProbeInput.events(action: action, point: CGPoint(x: x, y: y), window: window, frame: rect, backend: backend)
      guard !events.isEmpty else { throw ProbeFailure.unavailable("event creation failed") }
    }
    for event in events {
      let front = NSWorkspace.shared.frontmostApplication?.processIdentifier
      guard front == guardPid else { throw ProbeFailure.unavailable("foreground changed before input") }
      try ProbeInput.send(event, pid: pid, window: window, backend: backend,
        frame: rect, mouse: action == "click" || action == "scroll")
      for _ in 0..<8 { try await Task.sleep(nanoseconds: 5_000_000); samples.append(sample()) }
    }
    for _ in 0..<100 { try await Task.sleep(nanoseconds: 5_000_000); samples.append(sample()) }
    output["targetAfterInput"] = try readJSON(targetPath)
    // 仅在前台仍是自有守卫窗口时，发一对全局字母键验证系统键盘路由。
    // 这不是“用户正在同时打字”的证明，但可发现仅看 frontPid 会漏掉的焦点串线。
    guard NSWorkspace.shared.frontmostApplication?.processIdentifier == guardPid else {
      throw ProbeFailure.unavailable("foreground changed before guard key")
    }
    for down in [true, false] {
      let event = CGEvent(keyboardEventSource: ProbeInput.source, virtualKey: 9, keyDown: down)
      event?.flags = []
      event?.setIntegerValueField(.eventSourceUserData, value: ProbeInput.marker)
      event?.post(tap: .cghidEventTap)
      try await Task.sleep(nanoseconds: 20_000_000)
    }
    for _ in 0..<35 { try await Task.sleep(nanoseconds: 5_000_000); samples.append(sample()) }
    output["after"] = try readJSON(targetPath)
    output["guardAfter"] = try readJSON(foregroundPath)
    output["posted"] = true
  } catch {
    output["error"] = String(describing: error)
  }
  if let (pid, window) = focusedTarget {
    output["defocusStatus"] = try? ProbeInput.focus(pid: pid, window: window, enabled: false)
    try? await Task.sleep(nanoseconds: 100_000_000)
    samples.append(sample())
  }
  output["samples"] = samples
  return output
}
}

var lastRequest = ""
var busy = false
var commandTimer: Timer? = Timer.scheduledTimer(withTimeInterval: 0.05, repeats: true) { _ in
  guard !busy, let request = try? readJSON(probeDirectory.appendingPathComponent("request.json")),
    let id = request["id"] as? String, id != lastRequest else { return }
  lastRequest = id
  if request["action"] as? String == "quit" { application.terminate(nil); return }
  busy = true
  Task { @MainActor in
    writeProbeJSON(await ProbeRunner.run(request), name: "response.json")
    busy = false
  }
}
application.run()
