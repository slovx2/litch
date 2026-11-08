// 读连进来的那个进程的身份：系统用户、审计令牌对应的代码签名。判定规则在 Core 的 PeerAuth 里。
//
// 用审计令牌而不是进程号去查签名：进程号会被重用（对面退出、换成别的进程），审计令牌带着进程的“版本号”，
// 查到的一定是连进来的那个进程。
import Darwin
import Foundation
import LitchComputerUseCore
import Security

enum PeerVerifier {
  /// sys/un.h 里的 LOCAL_PEERTOKEN（取对面的审计令牌）
  private static let localPeerToken: Int32 = 0x006

  static func peer(fd: Int32, team: String?) -> PeerAuth.Peer {
    var uid: uid_t = 0
    var gid: gid_t = 0
    let peerUid: UInt32? = getpeereid(fd, &uid, &gid) == 0 ? uid : nil

    var token = audit_token_t()
    var length = socklen_t(MemoryLayout<audit_token_t>.size)
    guard getsockopt(fd, SOL_LOCAL, localPeerToken, &token, &length) == 0 else {
      return PeerAuth.Peer(uid: peerUid, teamId: nil, identifier: nil, signatureValid: false)
    }
    let tokenData = withUnsafeBytes(of: &token) { Data($0) }
    var code: SecCode?
    let attributes = [kSecGuestAttributeAudit: tokenData] as CFDictionary
    guard SecCodeCopyGuestWithAttributes(nil, attributes, [], &code) == errSecSuccess, let code
    else {
      return PeerAuth.Peer(uid: peerUid, teamId: nil, identifier: nil, signatureValid: false)
    }

    // 签名有效，且（正式版时）满足“苹果签发、这个团队”的要求串
    var valid = false
    if let team {
      var requirement: SecRequirement?
      if SecRequirementCreateWithString(
        PeerAuth.requirement(team: team) as CFString, [], &requirement) == errSecSuccess,
        let requirement
      {
        valid = SecCodeCheckValidity(code, [], requirement) == errSecSuccess
      }
    } else {
      valid = SecCodeCheckValidity(code, [], nil) == errSecSuccess
    }

    var staticCode: SecStaticCode?
    var info: CFDictionary?
    if SecCodeCopyStaticCode(code, [], &staticCode) == errSecSuccess, let staticCode {
      SecCodeCopySigningInformation(
        staticCode, SecCSFlags(rawValue: kSecCSSigningInformation), &info)
    }
    let dict = (info as? [String: Any]) ?? [:]
    return PeerAuth.Peer(
      uid: peerUid,
      teamId: dict[kSecCodeInfoTeamIdentifier as String] as? String,
      identifier: dict[kSecCodeInfoIdentifier as String] as? String,
      signatureValid: valid)
  }
}
