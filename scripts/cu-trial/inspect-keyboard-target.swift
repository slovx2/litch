// 只读 TextEdit 的输入路由证据；不记录目录文件列表，不发送事件，不请求权限。
import AppKit
import ApplicationServices
import Darwin

func copy<T>(_ element: AXUIElement, _ name: String) -> T? {
  var value: CFTypeRef?
  guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else { return nil }
  return value as? T
}
var result: [String: Any] = [:]
if let app = NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.TextEdit").first {
  let pid = app.processIdentifier
  let root = AXUIElementCreateApplication(pid)
  result["pid"] = pid
  let windows = CGWindowListCopyWindowInfo(.optionOnScreenOnly, kCGNullWindowID) as? [[String: Any]] ?? []
  result["windowOwners"] = windows.filter { $0[kCGWindowOwnerPID as String] as? Int == Int(pid) }
    .map { ["id": $0[kCGWindowNumber as String]!, "pid": pid] }
  if let focus: AXUIElement = copy(root, kAXFocusedUIElementAttribute as String) {
    var publicPID: pid_t = 0, actualPID: pid_t = 0
    AXUIElementGetPid(focus, &publicPID)
    typealias Query = @convention(c) (AXUIElement, UnsafeMutablePointer<pid_t>) -> AXError
    if let library = dlopen("/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices", RTLD_LAZY),
      let symbol = dlsym(library, "_AXUIElementGetActualPid") {
      let query = unsafeBitCast(symbol, to: Query.self)
      if query(focus, &actualPID) == .success {
        result["actualPID"] = actualPID
        result["actualBundle"] = NSRunningApplication(processIdentifier: actualPID)?.bundleIdentifier ?? ""
      }
    }
    result["publicPID"] = publicPID
    result["focusRole"] = copy(focus, kAXRoleAttribute as String) as String? ?? ""
    result["focusIdentifier"] = copy(focus, kAXIdentifierAttribute as String) as String? ?? ""
    // 只读本测试可能写入的名称/路径，不导出任意用户输入框内容。
    let value: String = copy(focus, kAXValueAttribute as String) ?? ""
    result["focusIsTestFilename"] = value == "cu-note.rtf"
  }
  var count = 0
  func inspect(_ element: AXUIElement, depth: Int) {
    guard depth < 40, count < 2000 else { return }
    count += 1
    let role: String = copy(element, kAXRoleAttribute as String) ?? ""
    let value: String = copy(element, kAXValueAttribute as String) ?? ""
    if role == kAXPopUpButtonRole, value == "litch-cu-trial" { result["testDestination"] = true }
    let children: [AXUIElement] = copy(element, kAXChildrenAttribute as String) ?? []
    for child in children.prefix(300) { inspect(child, depth: depth + 1) }
  }
  let axWindows: [AXUIElement] = copy(root, kAXWindowsAttribute as String) ?? []
  for window in axWindows { inspect(window, depth: 0) }
}
result["modifierFlags"] = [CGEventSourceStateID.combinedSessionState, .hidSystemState].map {
  CGEventSource.flagsState($0).intersection([.maskCommand, .maskShift, .maskAlternate, .maskControl, .maskSecondaryFn]).rawValue
}
print(String(decoding: try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys]), as: UTF8.self))
