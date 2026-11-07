// 只激活传入 PID 的隔离 CFT，只输出该进程的窗口；不读取或操作用户应用。
import AppKit
import CoreGraphics

let pid = pid_t(CommandLine.arguments[2])!
if CommandLine.arguments[1] == "activate" {
    guard let app = NSRunningApplication(processIdentifier: pid),
          app.localizedName == "Google Chrome for Testing" else { exit(1) }
    app.activate(options: [.activateIgnoringOtherApps])
} else {
    let windows = (CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? [])
        .filter { ($0[kCGWindowOwnerPID as String] as? Int32) == pid }
        .map { ["number": $0[kCGWindowNumber as String] ?? 0,
                "layer": $0[kCGWindowLayer as String] ?? 0,
                "bounds": $0[kCGWindowBounds as String] ?? [:]] }
    let value: [String: Any] = ["frontmost": NSWorkspace.shared.frontmostApplication?.processIdentifier == pid, "windows": windows]
    print(String(data: try! JSONSerialization.data(withJSONObject: value), encoding: .utf8)!)
}
