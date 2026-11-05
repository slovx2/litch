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
}
