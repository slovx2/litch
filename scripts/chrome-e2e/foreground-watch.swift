// 验收专用：只观察 macOS 前台应用，不激活、隐藏或恢复任何用户应用。
import AppKit
import Foundation

func emit(_ token: String) {
    let application = NSWorkspace.shared.frontmostApplication
    let pid = application?.processIdentifier ?? -1
    let value: [String: Any] = ["token": token, "pid": pid, "bundle": application?.bundleIdentifier ?? ""]
    let data = try! JSONSerialization.data(withJSONObject: value)
    FileHandle.standardOutput.write(data + Data([10]))
}

var lastPid = NSWorkspace.shared.frontmostApplication?.processIdentifier ?? -1
let observer = NSWorkspace.shared.notificationCenter.addObserver(
    forName: NSWorkspace.didActivateApplicationNotification,
    object: nil, queue: .main
) { _ in emit("activation") }
// 通知之外再采样，防止只看前后快照漏掉中途切换。
let timer = Timer.scheduledTimer(withTimeInterval: 0.02, repeats: true) { _ in
    let pid = NSWorkspace.shared.frontmostApplication?.processIdentifier ?? -1
    if pid != lastPid {
        lastPid = pid
        emit("sample")
    }
}
emit("ready")
DispatchQueue.global().async {
    while let token = readLine() {
        DispatchQueue.main.async { emit(token) }
    }
    exit(0)
}
RunLoop.main.run()
