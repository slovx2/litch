import XCTest
@testable import LitchComputerUseCore

final class ObservationWindowTests: XCTestCase {
  func testWindowlessObservationAllowsKeyboardButNeverCoordinates() throws {
    var state = ObservationWindow()
    XCTAssertThrowsError(try state.require(nil))
    state.observeApplication()
    try state.require(nil)
    XCTAssertThrowsError(try state.require(nil, screenshot: true))
    XCTAssertThrowsError(try state.require(7))
    state.observe(7)
    try state.require(7)
    XCTAssertThrowsError(try state.require(7, screenshot: true))
    state.capture(7)
    try state.require(7, screenshot: true)
    state.observeApplication()
    try state.require(nil)
    XCTAssertThrowsError(try state.require(7, screenshot: true))
  }
  func testNewWindowFromActionAcceptsSemanticInputButRejectsOldScreenshotCoordinates() throws {
    var state = ObservationWindow()
    XCTAssertThrowsError(try state.require(1))
    state.capture(1)
    try state.require(1, screenshot: true)
    // 新建窗口、打开对话框后，动作已返回窗口2的树，尚未返回窗口2的图片。
    state.observe(2)
    try state.require(2)
    XCTAssertThrowsError(try state.require(2, screenshot: true))
    XCTAssertThrowsError(try state.require(1))
    XCTAssertThrowsError(try state.require(3))
    state.capture(2)
    try state.require(2, screenshot: true)
    state.observe(nil)
    XCTAssertThrowsError(try state.require(2))
  }
}
