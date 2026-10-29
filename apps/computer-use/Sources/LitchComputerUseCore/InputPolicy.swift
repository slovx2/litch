// 后台能力与临时前台执行的纯决策，系统接口在可执行目标中。
public enum InputPolicy {
  public static let quietSeconds: Double = 2
  public static let waitSeconds: Double = 8

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

  public static func waitResult(elapsed: Double, idle: Double, cancelled: Bool) -> String {
    if cancelled { return "cancelled" }
    if idle >= quietSeconds { return "ready" }
    return elapsed >= waitSeconds ? "userActive" : "waiting"
  }
}
