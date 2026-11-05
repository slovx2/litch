import XCTest
@testable import LitchComputerUseCore

final class InputPolicyTests: XCTestCase {
  func testCommandShortcutsAndWindowlessKeysUseGuardedForeground() {
    XCTAssertTrue(InputPolicy.keyboardNeedsForeground(hasWindow: false, flags: 0))
    XCTAssertTrue(InputPolicy.keyboardNeedsForeground(hasWindow: true, flags: Keys.command))
    XCTAssertTrue(InputPolicy.keyboardNeedsForeground(hasWindow: true, flags: Keys.command | Keys.shift))
    XCTAssertFalse(InputPolicy.keyboardNeedsForeground(hasWindow: true, flags: 0))
    XCTAssertFalse(InputPolicy.keyboardNeedsForeground(hasWindow: true, flags: Keys.shift))
  }
  func testForegroundScrollDirection() {
    for delta in [Int32(-3), 0, 3] {
      XCTAssertEqual(InputPolicy.systemScrollDelta(delta, natural: true), -delta)
      XCTAssertEqual(InputPolicy.systemScrollDelta(delta, natural: false), delta)
    }
  }
  func testNoKeyboardPrivateRoute() {
    for action in ["typeText", "pressKey", "setValue", "selectText"] {
      XCTAssertFalse(InputPolicy.needsForeground(action: action, chromium: true, mouseReady: false))
    }
  }
  func testMouseCoverage() {
    XCTAssertTrue(InputPolicy.needsForeground(action: "click", chromium: true, mouseReady: true))
    XCTAssertFalse(InputPolicy.needsForeground(action: "scroll", chromium: true, mouseReady: true))
    XCTAssertTrue(InputPolicy.needsForeground(action: "scroll", chromium: false, mouseReady: false))
    XCTAssertFalse(InputPolicy.needsForeground(action: "click", chromium: false, mouseReady: true))
    XCTAssertTrue(InputPolicy.needsForeground(action: "drag", chromium: false, mouseReady: true))
  }
  func testBoundedIdleAndCancellation() {
    XCTAssertEqual(InputPolicy.waitResult(elapsed: 1, blocked: true, cancelled: false), "waiting")
    XCTAssertEqual(InputPolicy.waitResult(elapsed: 8, blocked: true, cancelled: false), "userActive")
    XCTAssertEqual(InputPolicy.waitResult(elapsed: 8, blocked: false, cancelled: false), "ready")
    XCTAssertEqual(InputPolicy.waitResult(elapsed: 0, blocked: false, cancelled: true), "cancelled")
  }
}
