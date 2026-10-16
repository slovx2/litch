// 屏幕提示上的字。跟 Litch 的界面语言走（主进程在握手和改语言时告诉助手），只有中文和英文两种。

public enum Copy {
  public enum Language: String, Sendable {
    case zh
    case en
  }

  /// 把主进程给的语言名认成两种之一：中文开头的算中文，别的一律英文
  public static func language(_ raw: String?) -> Language {
    guard let raw = raw?.lowercased() else { return .en }
    return raw.hasPrefix("zh") ? .zh : .en
  }

  /// 提示的标题：正在操作哪个应用
  public static func banner(_ language: Language, app: String) -> String {
    switch language {
    case .zh: return "Litch 正在操作「\(app)」"
    case .en: return "Litch is controlling \(app)"
    }
  }

  /// 提示的副标题：怎么停
  public static func hint(_ language: Language) -> String {
    switch language {
    case .zh: return "按 Esc 或点“停止”收回控制"
    case .en: return "Press Esc or click Stop to take back control"
    }
  }

  public static func stop(_ language: Language) -> String {
    switch language {
    case .zh: return "停止"
    case .en: return "Stop"
    }
  }

  /// 同时在操作几个应用时标题里的应用名
  public static func apps(_ language: Language, names: [String]) -> String {
    switch language {
    case .zh: return names.joined(separator: "、")
    case .en: return names.joined(separator: ", ")
    }
  }
}
