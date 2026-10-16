// 助手这一侧的底线名单：无论主进程怎么说都不操作的应用。
// 完整的名单（禁止和高风险）和审批在主进程（apps/desktop/src/computer-use/policy.mts），这里只留最要紧的几类，
// 防的是主进程那一侧出了错：Litch 自己和本助手、钥匙串与密码、系统认证弹窗、系统设置（模型能改设置就能给自己开权限）。
// 两边的名单改的时候一起看：这里的每一项主进程那份里都要有。
import Foundation

public enum Baseline {
  public static let forbiddenBundleIds: Set<String> = [
    "io.github.slovx2.litch",
    "io.github.slovx2.litch.computer-use",
    "com.apple.keychainaccess",
    "com.apple.Passwords",
    "com.apple.SecurityAgent",
    "com.apple.LocalAuthentication.UIAgent",
    "com.apple.loginwindow",
    "com.apple.systempreferences",
    "com.apple.Settings",
  ]

  /// 包标识以这些开头的一律不操作（密码管理器）
  public static let forbiddenPrefixes: [String] = [
    "com.1password.", "com.agilebits.", "com.bitwarden.", "com.lastpass.", "com.dashlane.",
    "com.nordpass.", "me.proton.pass", "org.keepassxc.", "com.keepersecurity.",
  ]

  public static func isForbidden(bundleId: String?) -> Bool {
    guard let id = bundleId, !id.isEmpty else { return false }
    if forbiddenBundleIds.contains(id) { return true }
    return forbiddenPrefixes.contains { id.hasPrefix($0) }
  }
}
