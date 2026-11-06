import XCTest
@testable import LitchComputerUseCore

final class InputConflictTests: XCTestCase {
  func testLookingMovingAndScrollingNeverCollide() {
    var state = InputConflict()
    for kind in [InputConflict.Kind.activate, .move, .scroll] { state.note(kind, pid: 10) }
    XCTAssertFalse(state.collided(background: false, pid: 10, since: 0))
    XCTAssertFalse(state.blocked(background: false))
  }
  func testOtherAppTypingDoesNotCollideAndOnlyHeldKeyDelaysActivation() {
    var state = InputConflict()
    state.note(.keyDown, pid: 20, code: 1)
    XCTAssertFalse(state.collided(background: false, pid: 10, since: 0))
    XCTAssertTrue(state.blocked(background: false))
    state.note(.keyUp, pid: 20, code: 1)
    XCTAssertFalse(state.blocked(background: false))
  }
  func testTargetClickStopsOnlyCurrentStepAndNextStepCanRetry() {
    var state = InputConflict()
    let before = state.revision(pid: 10)
    state.note(.mouseDown, pid: 10)
    XCTAssertTrue(state.collided(background: false, pid: 10, since: before))
    state.note(.mouseUp, pid: 10)
    XCTAssertFalse(state.collided(background: false, pid: 10, since: state.revision(pid: 10)))
    XCTAssertFalse(state.blocked(background: false))
  }
  func testBackgroundIgnoresEveryKindOfUserActivity() {
    var state = InputConflict()
    state.note(.mouseDown, pid: 10)
    state.note(.keyDown, pid: 10)
    XCTAssertFalse(state.collided(background: true, pid: 10, since: 0))
    XCTAssertFalse(state.blocked(background: true, composing: true))
  }
  func testHeldDragAndCompositionBlockOnlyForeground() {
    var state = InputConflict()
    state.note(.mouseDown, pid: 20)
    XCTAssertTrue(state.blocked(background: false))
    state.note(.mouseUp, pid: 20)
    XCTAssertFalse(state.blocked(background: false))
    XCTAssertTrue(state.blocked(background: false, composing: true))
  }

  func testMissedReleaseStaysBlockedUntilHardwareSnapshotReplacesEventCache() {
    var state = InputConflict()
    state.note(.keyDown, pid: 10, code: 12)
    state.note(.mouseDown, pid: 10, code: 4)
    state.note(.activate, pid: 20)
    // 复现旧实现：切焦点后没收到释放事件，哪怕过了等待期限仍然阻塞。
    XCTAssertTrue(state.blocked(background: false))
    let revision = state.revision(pid: 10)
    state.refreshHeld(keys: [], buttons: [])
    XCTAssertFalse(state.blocked(background: false))
    XCTAssertEqual(state.revision(pid: 10), revision)
    // 新快照仍有按住时必须阻塞，不能靠超时强行放行。
    state.refreshHeld(keys: [54], buttons: [4])
    XCTAssertTrue(state.blocked(background: false))
    XCTAssertTrue(state.pointerHeld)
    XCTAssertFalse(state.blocked(background: true))
  }
}
