// 只记前台应用和光标坐标。通知加 5ms 采样，不读取用户窗口或键盘内容。
import AppKit
import ApplicationServices

var previousPID: pid_t = -1
var previousCursor = CGPoint(x: -1, y: -1)
var previousDown = false
func emit(_ kind: String) {
  let app = NSWorkspace.shared.frontmostApplication
  let cursor = CGEvent(source: nil)?.location ?? .zero
  previousPID = app?.processIdentifier ?? -1
  previousCursor = cursor
  previousDown = CGEventSource.buttonState(.combinedSessionState, button: .left)
  let value: [String: Any] = ["token": kind, "pid": previousPID,
    "bundle": app?.bundleIdentifier ?? "", "x": cursor.x, "y": cursor.y,
    "uptime": ProcessInfo.processInfo.systemUptime, "leftDown": previousDown]
  let data = try! JSONSerialization.data(withJSONObject: value)
  FileHandle.standardOutput.write(data + Data([10]))
}
let observer = NSWorkspace.shared.notificationCenter.addObserver(
  forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main
) { _ in emit("activation") }
let timer = Timer.scheduledTimer(withTimeInterval: 0.005, repeats: true) { _ in
  if NSWorkspace.shared.frontmostApplication?.processIdentifier != previousPID ||
    CGEvent(source: nil)?.location != previousCursor ||
    CGEventSource.buttonState(.combinedSessionState, button: .left) != previousDown { emit("sample") }
}
emit("ready")
DispatchQueue.global().async {
  while let token = readLine() { DispatchQueue.main.async { emit(token) } }
  exit(0)
}
RunLoop.main.run()
