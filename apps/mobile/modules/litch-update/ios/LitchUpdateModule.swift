import CryptoKit
import ExpoModulesCore

public final class LitchUpdateModule: Module {
  public func definition() -> ModuleDefinition {
    Name("LitchUpdate")
    Function("canInstall") { false }
    Function("openInstallSettings") { false }
    // JS 在 iOS 不进入 APK 流程；原生边界也拒绝安装，不伪造 Android 包信息。
    Function("install") { (_: String) in throw InstallUnavailable() }
    AsyncFunction("inspect") { (_: String) -> String in throw InstallUnavailable() }
    AsyncFunction("sha256") { (path: String) -> String in
      let url = path.hasPrefix("file://") ? URL(string: path) : URL(fileURLWithPath: path)
      guard let url, url.isFileURL else { throw InvalidFile() }
      let file = try FileHandle(forReadingFrom: url)
      defer { try? file.close() }
      var digest = SHA256()
      while let data = try file.read(upToCount: 1 << 20), !data.isEmpty { digest.update(data: data) }
      return digest.finalize().map { String(format: "%02x", $0) }.joined()
    }
  }
}

private final class InstallUnavailable: Exception {
  override var reason: String { "App Store / TestFlight updates only" }
}
private final class InvalidFile: Exception {
  override var reason: String { "Invalid local file URL" }
}
