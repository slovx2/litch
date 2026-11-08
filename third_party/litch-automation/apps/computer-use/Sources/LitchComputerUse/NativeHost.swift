import Foundation
import LitchComputerUseCore

enum NativeHost {
  // 由每个宿主的构建器写入，codesign 覆盖；缺失或损坏直接终止，不能退回开发 token。
  static let identity: HostIdentity = {
    guard let text = Bundle.main.infoDictionary?["ComputerUseHostIdentity"] as? String,
      let identity = try? HostIdentity.decode(text), identity.helperId == Bundle.main.bundleIdentifier
    else { fatalError("Computer Use helper has no valid signed host identity") }
    return identity
  }()
}
