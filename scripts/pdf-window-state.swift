// 仅查询本轮验收是否意外显示窗口/抢焦点；不发系统输入，不读取窗口内容。
import AppKit
import CoreGraphics
import Foundation
let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
let pids = windows.filter { ($0[kCGWindowLayer as String] as? Int) == 0 }.compactMap { $0[kCGWindowOwnerPID as String] as? Int }
let result: [String: Any] = ["visible": pids, "front": NSWorkspace.shared.frontmostApplication?.processIdentifier ?? -1]
print(String(data: try JSONSerialization.data(withJSONObject: result), encoding: .utf8)!)
