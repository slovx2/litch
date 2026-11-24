// 验收专用：只读出屏幕上普通层窗口的前后顺序（仅所属 PID，不读标题、名称或内容）。
// `restore <pid>`：复现模式下 Chrome 已经抢走前台时，把前台还给验收开始时的那个应用；不碰其他应用。
import AppKit
import CoreGraphics

if CommandLine.arguments.count == 3, CommandLine.arguments[1] == "restore",
   let pid = pid_t(CommandLine.arguments[2]),
   let app = NSRunningApplication(processIdentifier: pid) {
    app.activate(options: [.activateIgnoringOtherApps])
    exit(0)
}
let windows = (CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? [])
    .filter { ($0[kCGWindowLayer as String] as? Int) == 0 }
    .compactMap { $0[kCGWindowOwnerPID as String] as? Int32 }
let value: [String: Any] = [
    "frontmost": NSWorkspace.shared.frontmostApplication?.processIdentifier ?? -1,
    "order": windows,
]
print(String(data: try! JSONSerialization.data(withJSONObject: value), encoding: .utf8)!)
