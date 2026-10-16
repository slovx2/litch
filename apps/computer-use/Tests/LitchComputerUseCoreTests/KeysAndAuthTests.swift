import XCTest

@testable import LitchComputerUseCore

final class KeysTests: XCTestCase {
  func testCombos() throws {
    XCTAssertEqual(try Keys.parse("cmd+shift+t"), KeyCombo(keyCode: 0x11, flags: Keys.command | Keys.shift))
    XCTAssertEqual(try Keys.parse("Return"), KeyCombo(keyCode: 0x24, flags: 0))
    XCTAssertEqual(try Keys.parse("ctrl+Page_Up"), KeyCombo(keyCode: 0x74, flags: Keys.control))
    XCTAssertEqual(try Keys.parse("BackSpace"), KeyCombo(keyCode: 0x33, flags: 0))
    XCTAssertEqual(try Keys.parse("alt+Left"), KeyCombo(keyCode: 0x7B, flags: Keys.option))
    XCTAssertEqual(try Keys.parse("F12"), KeyCombo(keyCode: 0x6F, flags: 0))
    XCTAssertEqual(try Keys.parse("cmd+A"), KeyCombo(keyCode: 0x00, flags: Keys.command))
    XCTAssertEqual(try Keys.parse("cmd+,"), KeyCombo(keyCode: 0x2B, flags: Keys.command))
    XCTAssertEqual(try Keys.parse("cmd+-"), KeyCombo(keyCode: 0x1B, flags: Keys.command))
    XCTAssertEqual(try Keys.parse("cmd++"), KeyCombo(keyCode: 0x18, flags: Keys.command | Keys.shift))
    XCTAssertEqual(try Keys.parse("Escape"), KeyCombo(keyCode: 0x35, flags: 0))
    XCTAssertEqual(try Keys.parse("shift"), KeyCombo(keyCode: 0x38, flags: Keys.shift))
  }

  func testUnknown() {
    XCTAssertThrowsError(try Keys.parse("hyper+a"))
    XCTAssertThrowsError(try Keys.parse("cmd+launchrocket"))
    XCTAssertThrowsError(try Keys.parse(""))
    XCTAssertThrowsError(try Keys.parse("cmd+"))
  }
}

final class PeerAuthTests: XCTestCase {
  private let token = String(repeating: "ab", count: 24)

  func testModeFollowsOwnSignature() {
    XCTAssertEqual(PeerAuth.mode(ownTeam: "TEAM123", launchToken: token), .team("TEAM123"))
    XCTAssertEqual(PeerAuth.mode(ownTeam: nil, launchToken: token), .token(token))
    XCTAssertEqual(PeerAuth.mode(ownTeam: "", launchToken: token), .token(token))
    XCTAssertEqual(PeerAuth.mode(ownTeam: nil, launchToken: "short"), .closed)
    XCTAssertEqual(PeerAuth.mode(ownTeam: nil, launchToken: nil), .closed)
  }

  func testTeamMode() {
    let litch = PeerAuth.Peer(uid: 501, teamId: "T", identifier: "io.github.slovx2.litch", signatureValid: true)
    XCTAssertNil(PeerAuth.check(mode: .team("T"), ownUid: 501, peer: litch, offeredToken: nil))
    // 正式版不认令牌
    let node = PeerAuth.Peer(uid: 501, teamId: nil, identifier: "node", signatureValid: true)
    XCTAssertNotNil(PeerAuth.check(mode: .team("T"), ownUid: 501, peer: node, offeredToken: token))
    var other = litch
    other.teamId = "X"
    XCTAssertNotNil(PeerAuth.check(mode: .team("T"), ownUid: 501, peer: other, offeredToken: nil))
    var tampered = litch
    tampered.signatureValid = false
    XCTAssertNotNil(PeerAuth.check(mode: .team("T"), ownUid: 501, peer: tampered, offeredToken: nil))
    var sameTeamOtherApp = litch
    sameTeamOtherApp.identifier = "io.github.slovx2.other"
    XCTAssertNotNil(PeerAuth.check(mode: .team("T"), ownUid: 501, peer: sameTeamOtherApp, offeredToken: nil))
  }

  func testTokenMode() {
    let peer = PeerAuth.Peer(uid: 501, teamId: nil, identifier: nil, signatureValid: false)
    XCTAssertNil(PeerAuth.check(mode: .token(token), ownUid: 501, peer: peer, offeredToken: token))
    XCTAssertNotNil(PeerAuth.check(mode: .token(token), ownUid: 501, peer: peer, offeredToken: nil))
    XCTAssertNotNil(PeerAuth.check(mode: .token(token), ownUid: 501, peer: peer, offeredToken: token + "x"))
    XCTAssertNotNil(PeerAuth.check(mode: .closed, ownUid: 501, peer: peer, offeredToken: token))
  }

  func testOtherUserAlwaysRejected() {
    let peer = PeerAuth.Peer(uid: 0, teamId: "T", identifier: "io.github.slovx2.litch", signatureValid: true)
    XCTAssertNotNil(PeerAuth.check(mode: .team("T"), ownUid: 501, peer: peer, offeredToken: nil))
    XCTAssertNotNil(PeerAuth.check(mode: .token(token), ownUid: 501, peer: peer, offeredToken: token))
  }

  func testRequirementString() {
    XCTAssertEqual(
      PeerAuth.requirement(team: "ABCDE12345"),
      "anchor apple generic and certificate leaf[subject.OU] = \"ABCDE12345\"")
  }

  func testConstantTimeEqual() {
    XCTAssertTrue(PeerAuth.constantTimeEqual("abc", "abc"))
    XCTAssertFalse(PeerAuth.constantTimeEqual("abc", "abd"))
    XCTAssertFalse(PeerAuth.constantTimeEqual("abc", "abcd"))
    XCTAssertFalse(PeerAuth.constantTimeEqual("", "a"))
  }
}

final class BaselineAndCopyTests: XCTestCase {
  func testBaseline() {
    XCTAssertTrue(Baseline.isForbidden(bundleId: "io.github.slovx2.litch"))
    XCTAssertTrue(Baseline.isForbidden(bundleId: "com.1password.1password"))
    XCTAssertTrue(Baseline.isForbidden(bundleId: "com.apple.systempreferences"))
    XCTAssertFalse(Baseline.isForbidden(bundleId: "com.apple.TextEdit"))
    XCTAssertFalse(Baseline.isForbidden(bundleId: nil))
  }

  func testCopy() {
    XCTAssertEqual(Copy.language("zh-CN"), .zh)
    XCTAssertEqual(Copy.language("en"), .en)
    XCTAssertEqual(Copy.language(nil), .en)
    XCTAssertEqual(Copy.banner(.zh, app: "备忘录"), "Litch 正在操作「备忘录」")
    XCTAssertEqual(Copy.banner(.en, app: "Notes"), "Litch is controlling Notes")
    XCTAssertEqual(Copy.apps(.zh, names: ["A", "B"]), "A、B")
  }
}
