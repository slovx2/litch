// 身份来自签名封装内的 Info.plist；绝不从 RPC 参数或启动环境放宽正式 peer 信任。
import Foundation

public struct HostIdentity: Codable, Equatable, Sendable {
  public let productName: String
  public let helperName: String
  public let helperId: String
  public let allowedPeerIds: [String]
  public let protectedTargetIds: [String]
  public let isolationEnvironmentKeys: [String]
  public let directoryEnvironmentKey: String
  public let tokenEnvironmentKey: String
  public let defaultStateSubdirectory: String

  public static func decode(_ text: String) throws -> HostIdentity {
    let identity = try JSONDecoder().decode(HostIdentity.self, from: Data(text.utf8))
    guard !identity.productName.isEmpty, !identity.helperName.isEmpty, !identity.helperId.isEmpty,
      !identity.allowedPeerIds.isEmpty, !identity.protectedTargetIds.isEmpty,
      identity.allowedPeerIds.allSatisfy({ !$0.isEmpty }),
      identity.protectedTargetIds.allSatisfy({ !$0.isEmpty }),
      [identity.directoryEnvironmentKey, identity.tokenEnvironmentKey].allSatisfy({ !$0.isEmpty }),
      !identity.defaultStateSubdirectory.isEmpty,
      !identity.defaultStateSubdirectory.hasPrefix("/"),
      !identity.defaultStateSubdirectory.split(separator: "/").contains("..")
    else { throw RPCError(.invalid, "invalid native host identity") }
    return identity
  }
}
