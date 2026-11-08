// 后台能力与临时前台执行的纯决策，系统接口在可执行目标中。
public enum InputPolicy {
  public static let waitSeconds: Double = 8

  /// 事件携带的实际接收窗口优先；屏幕矩形重叠不能证明窗口接收了点击。
  public static func mouseRecipient(windowIDs: [Int64], owner: (UInt32) -> Int32?) -> Int32? {
    var seen = Set<UInt32>()
    for value in windowIDs where value > 0 && value <= Int64(UInt32.max) {
      let id = UInt32(value)
      guard seen.insert(id).inserted else { continue }
      if let pid = owner(id), pid > 0 { return pid }
    }
    return nil
  }

  /// AppKit 的菜单快捷键在后台可能被忽略；窗口缺失或使用 Command 时在受控前台发送。
  public static func keyboardNeedsForeground(hasWindow: Bool, flags: UInt64, remoteFocus: Bool = false) -> Bool {
    remoteFocus || !hasWindow || flags & Keys.command != 0
  }

  public static func systemScrollDelta(_ delta: Int32, natural: Bool) -> Int32 {
    natural ? -delta : delta
  }

  public static func needsForeground(action: String, chromium: Bool, mouseReady: Bool) -> Bool {
    switch action {
    case "drag": return true
    case "click": return chromium || !mouseReady
    case "scroll": return !mouseReady
    default: return false
    }
  }

  public static func waitResult(elapsed: Double, blocked: Bool, cancelled: Bool) -> String {
    if cancelled { return "cancelled" }
    if !blocked { return "ready" }
    return elapsed >= waitSeconds ? "userActive" : "waiting"
  }
}
