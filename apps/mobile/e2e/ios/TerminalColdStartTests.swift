import XCTest

final class TerminalColdStartTests: XCTestCase {
  private let app = XCUIApplication(bundleIdentifier: "dev.litch.app.dev")

  func testFirstKeyboardTapAfterColdStart() throws {
    continueAfterFailure = false
    XCUIDevice.shared.orientation = .portrait
    app.terminate()
    app.launch()
    app.agreeToLaunchConsentIfNeeded()
    XCTAssertTrue(app.otherElements["devices"].waitForExistence(timeout: 15))
    app.open(URL(string: "litch-dev://boot?mode=mock")!)
    let local = app.buttons["device:local"]
    for _ in 0..<4 {
      if local.exists { break }
      app.swipeUp()
    }
    XCTAssertTrue(local.waitForExistence(timeout: 15))
    for attempt in 1...10 {
      app.terminate()
      app.launch()
      XCTAssertTrue(app.otherElements["devices"].waitForExistence(timeout: 15))
      // 从外部送深链，避免 XCUIApplication.open 自带的空闲等待把首次点击拖到页面已完全稳定。
      try openTerminal()
      let button = app.buttons["terminal:key:keyboard"]
      let deadline = Date().addingTimeInterval(15)
      while Date() < deadline && (!button.exists || !button.isEnabled) {
        let open = XCUIApplication(bundleIdentifier: "com.apple.springboard").buttons.matching(NSPredicate(format: "label == %@ OR label == %@", "打开", "Open")).firstMatch
        if open.exists { open.tap() }
        RunLoop.current.run(until: Date().addingTimeInterval(0.02))
      }
      XCTAssertTrue(button.isEnabled)
      button.tap()
      let visible = app.keyboards.firstMatch.waitForExistence(timeout: 5)
      if !visible { print("LITCH_COLD_FOCUS_FAILURE attempt=\(attempt) \(app.debugDescription)") }
      XCTAssertTrue(visible, "第 \(attempt) 次冷启动首次点击未弹键盘")
      print("LITCH_COLD_FOCUS_PASS attempt=\(attempt)")
    }
  }

  private func openTerminal() throws {
    let file = Bundle(for: Self.self).url(forResource: "validation", withExtension: "json")!
    let config = try JSONSerialization.jsonObject(with: Data(contentsOf: file)) as! [String: String]
    let done = expectation(description: "打开终端")
    var failure: Error?
    var request = URLRequest(url: URL(string: config["helper"]! + "/cold/terminal")!)
    request.httpMethod = "POST"
    URLSession.shared.dataTask(with: request) { _, _, error in failure = error; done.fulfill() }.resume()
    wait(for: [done], timeout: 10)
    if let failure { throw failure }
  }
}
