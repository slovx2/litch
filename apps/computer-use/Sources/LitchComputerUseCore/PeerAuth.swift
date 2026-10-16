// 谁能连进来：规则在这里，取签名信息的系统调用在可执行文件里（PeerVerifier.swift）。
//
// 两种情形，按助手自己的签名定，不看对面说什么：
//   正式版   助手带团队号（开发者身份签名）。对面必须是同一个团队签的、签名有效、签名标识是 Litch 主程序。
//            这时不认一次性令牌：令牌只是开发期的退路，正式版里留着它等于开了后门。
//   开发期   助手没有团队号（临时签名）。对面要在握手的第一帧里带上拉起助手时经环境变量交给它的一次性令牌。
// 两种情形都先要求对面和助手是同一个系统用户（套接字文件本身也只有属主能读写）。
import Foundation

public enum PeerAuth {
  /// Litch 主程序的签名标识（Electron 主进程那个可执行文件，和应用的包标识一样）
  public static let litchIdentifiers: Set<String> = ["io.github.slovx2.litch"]

  /// 对面的签名信息（读不到的项是 nil）
  public struct Peer: Equatable, Sendable {
    public var uid: UInt32?
    public var teamId: String?
    public var identifier: String?
    /// 按要求串校验过签名（未被改动、证书链对、团队号对）
    public var signatureValid: Bool

    public init(uid: UInt32?, teamId: String?, identifier: String?, signatureValid: Bool) {
      self.uid = uid
      self.teamId = teamId
      self.identifier = identifier
      self.signatureValid = signatureValid
    }
  }

  public enum Mode: Equatable, Sendable {
    /// 按团队号验对面
    case team(String)
    /// 开发期：认一次性令牌
    case token(String)
    /// 开发期但没给令牌：谁都不认
    case closed
  }

  /// 按助手自己的团队号和拉起时给的令牌定模式
  public static func mode(ownTeam: String?, launchToken: String?) -> Mode {
    if let team = ownTeam, !team.isEmpty { return .team(team) }
    if let token = launchToken, token.count >= 32 { return .token(token) }
    return .closed
  }

  /// 正式版校验对面签名用的要求串：苹果签发的证书链、叶证书的组织单元是这个团队
  public static func requirement(team: String) -> String {
    "anchor apple generic and certificate leaf[subject.OU] = \"\(team)\""
  }

  /// 判定。通过回 nil，不通过回给对面看的原因
  public static func check(mode: Mode, ownUid: UInt32, peer: Peer, offeredToken: String?)
    -> String?
  {
    guard let uid = peer.uid, uid == ownUid else {
      return "the connecting process belongs to another user"
    }
    switch mode {
    case .closed:
      return "this helper was started without a launch token and is not signed; restart it from Litch"
    case .token(let expected):
      guard let offered = offeredToken, constantTimeEqual(offered, expected) else {
        return "launch token missing or wrong"
      }
      return nil
    case .team(let team):
      guard peer.signatureValid, peer.teamId == team else {
        return "the connecting process is not signed by team \(team)"
      }
      guard let identifier = peer.identifier, litchIdentifiers.contains(identifier) else {
        return "the connecting process is not Litch"
      }
      return nil
    }
  }

  /// 比较令牌，用时和在哪一位不同无关
  public static func constantTimeEqual(_ left: String, _ right: String) -> Bool {
    let a = Array(left.utf8)
    let b = Array(right.utf8)
    var difference = UInt8(a.count == b.count ? 0 : 1)
    for index in 0..<max(a.count, b.count) {
      let x = index < a.count ? a[index] : 0
      let y = index < b.count ? b[index] : 0
      difference |= x ^ y
    }
    return difference == 0
  }
}
