import XCTest
@testable import LitchComputerUseCore

final class SelfTargetTests: XCTestCase {
  func testOnlyReleaseIsProtected() {
    XCTAssertTrue(SelfTarget.matches(bundleId: "io.github.slovx2.litch", isolated: false))
    for id in ["io.github.slovx2.litch.dev", "io.github.slovx2.litch.test", "io.github.slovx2.litch.beta", "com.github.Electron", "com.apple.TextEdit"] {
      XCTAssertFalse(SelfTarget.matches(bundleId: id, isolated: false))
    }
    XCTAssertFalse(SelfTarget.matches(bundleId: "io.github.slovx2.litch", isolated: true))
  }
  func testProfileOnlyCountsInEnvironment() {
    let prefix: [UInt8] = [2, 0, 0, 0]
    XCTAssertTrue(SelfTarget.isolated(arguments: prefix + Array("/Litch\0\0/Litch\0--test\0LITCH_PROFILE=/tmp/test\0\0".utf8)))
    XCTAssertFalse(SelfTarget.isolated(arguments: prefix + Array("/Litch\0\0/Litch\0LITCH_PROFILE=/tmp/test\0PATH=/bin\0\0".utf8)))
    XCTAssertFalse(SelfTarget.isolated(arguments: prefix + Array("/Litch\0\0/Litch\0--test\0LITCH_PROFILE=\0\0".utf8)))
  }
}
