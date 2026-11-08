import XCTest
@testable import LitchComputerUseCore

final class InputPolicyTests: XCTestCase {
  func testMenuShortcutRequiresExactKeyAndModifiers() {
    let combo = KeyCombo(keyCode: 0, flags: Keys.command)
    XCTAssertTrue(InputPolicy.menuShortcutMatches(keyCode: 0, modifiers: 0, combo: combo))
    for modifiers in [1, 2, 4, 8, 16, -1] {
      XCTAssertFalse(InputPolicy.menuShortcutMatches(keyCode: 0, modifiers: modifiers, combo: combo))
    }
    XCTAssertFalse(InputPolicy.menuShortcutMatches(keyCode: 1, modifiers: 0, combo: combo))
    XCTAssertTrue(InputPolicy.menuShortcutMatches(keyCode: 0, modifiers: 7,
      combo: KeyCombo(keyCode: 0, flags: Keys.command | Keys.shift | Keys.option | Keys.control)))
  }
  func testMouseRecipientUsesTheEventWindowNotAnOverlappingWindow() {
    let owners: [UInt32: Int32] = [10: 100, 20: 200]
    XCTAssertEqual(InputPolicy.mouseRecipient(windowIDs: [10, 10, 10], owner: { owners[$0] }), 100)
    XCTAssertEqual(InputPolicy.mouseRecipient(windowIDs: [0, 10], owner: { owners[$0] }), 100)
  }
  func testMouseRecipientRejectsInvalidOrMissingWindowIdentifiers() {
    var queried: [UInt32] = []
    XCTAssertNil(InputPolicy.mouseRecipient(windowIDs: [-1, 0, Int64(UInt32.max) + 1, 12, 12], owner: {
      queried.append($0); return nil
    }))
    XCTAssertEqual(queried, [12])
  }
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
    XCTAssertTrue(InputPolicy.needsForeground(action: "drag", chromium: true, mouseReady: true))
    XCTAssertTrue(InputPolicy.needsForeground(action: "drag", chromium: false, mouseReady: false))
  }
  func testUserActivityMakesMouseSelfTestRetryable() {
    XCTAssertEqual(InputPolicy.mouseSelfTestResult(clicked: true, scrolled: true,
      frontStable: true, cursorStable: false, userActive: true), "interrupted")
    XCTAssertEqual(InputPolicy.mouseSelfTestResult(clicked: false, scrolled: false,
      frontStable: false, cursorStable: false, userActive: true), "interrupted")
    XCTAssertEqual(InputPolicy.mouseSelfTestResult(clicked: true, scrolled: true,
      frontStable: true, cursorStable: true, userActive: false), "available")
    XCTAssertEqual(InputPolicy.mouseSelfTestResult(clicked: true, scrolled: true,
      frontStable: true, cursorStable: false, userActive: false), "unavailable")
  }
  func testBoundedIdleAndCancellation() {
    XCTAssertEqual(InputPolicy.waitResult(elapsed: 1, blocked: true, cancelled: false), "waiting")
    XCTAssertEqual(InputPolicy.waitResult(elapsed: 8, blocked: true, cancelled: false), "userActive")
    XCTAssertEqual(InputPolicy.waitResult(elapsed: 8, blocked: false, cancelled: false), "ready")
    XCTAssertEqual(InputPolicy.waitResult(elapsed: 0, blocked: false, cancelled: true), "cancelled")
  }
}
