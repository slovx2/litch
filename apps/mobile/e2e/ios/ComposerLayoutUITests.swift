import XCTest

// 只使用模拟核心；在 Litch-iOS 专用手机/平板模拟器上复用同一几何断言。
final class ComposerLayoutUITests: XCTestCase {
  private let app = XCUIApplication(bundleIdentifier: "dev.litch.app.dev")

  private func wait(_ label: String, _ condition: @escaping () -> Bool) {
    let expected = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in condition() }, object: app)
    XCTAssertEqual(XCTWaiter.wait(for: [expected], timeout: 15), .completed, label)
  }

  private func width(_ label: String) -> CGRect {
    let field = app.textViews["composer-input"]
    let more = app.buttons["composer-more"].frame
    let send = app.buttons["composer-send"].frame
    let rect = field.frame
    let gap = rect.minX - more.maxX
    XCTAssertGreaterThan(gap, 0, label)
    XCTAssertEqual(send.minX - rect.maxX, gap, accuracy: 1.5, label)
    XCTAssertFalse(app.buttons["settings:usage"].exists, "用量不占输入行")
    return rect
  }

  func testComposerPhoneAndTablet() {
    continueAfterFailure = false
    XCUIDevice.shared.orientation = .portrait
    app.launch()
    app.agreeToLaunchConsentIfNeeded()
    app.open(URL(string: "litch-dev://boot?mode=mock")!)
    wait("模拟核心已就绪") { self.app.buttons["devices:managers"].exists }
    for session in ["p2", "s2"] {
      app.open(URL(string: "litch-dev://open?session=\(session)&device=local")!)
      let input = app.textViews["composer-input"]
      XCTAssertTrue(input.waitForExistence(timeout: 15))
      let empty = width("\(session) 空白")
      input.tap()
      input.typeText("ab")
      let short = width("\(session) 短文本")
      XCTAssertEqual(short.width, empty.width, accuracy: 1.5)
      input.typeText("\ncd")
      let line = width("\(session) 换行")
      XCTAssertGreaterThan(line.height, short.height)
      input.typeText(String(repeating: " long text", count: 30))
      let long = width("\(session) 长文本")
      XCTAssertEqual(long.width, empty.width, accuracy: 1.5)
      XCTAssertGreaterThanOrEqual(long.height, line.height)
      input.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 305))
      XCTAssertEqual(width("\(session) 清空").height, empty.height, accuracy: 1.5)
      for _ in 0..<2 {
        app.buttons["keyboard:done"].tap()
        input.tap()
        input.typeText("ab")
        XCTAssertEqual(width("\(session) 重排").width, empty.width, accuracy: 1.5)
        input.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 2))
      }
      app.buttons["keyboard:done"].tap()
      app.buttons["composer-more"].tap()
      let usage = app.buttons["settings:usage"]
      XCTAssertTrue(usage.waitForExistence(timeout: 5))
      XCTAssertTrue(usage.label.contains("%"), "菜单直接读到百分比")
      usage.tap()
      XCTAssertTrue(app.otherElements["usage:sheet"].waitForExistence(timeout: 5))
      app.descendants(matching: .any)["usage:scrim"].coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.1)).tap()
    }
  }
}
