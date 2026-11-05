import XCTest

final class TerminalInputTests: XCTestCase {
  private let app = XCUIApplication(bundleIdentifier: "dev.litch.app.dev")

  override func setUpWithError() throws {
    continueAfterFailure = false
    XCUIDevice.shared.orientation = .portrait
    app.activate()
    XCTAssertTrue(app.wait(for: .runningForeground, timeout: 10))
    // 首次启动先等 JS 监听器挂好，再切换核心，避免冷启动链接竞争。
    if !app.otherElements["terminal"].exists {
      app.open(URL(string: "litch-dev://home")!)
      XCTAssertTrue(app.otherElements["devices"].waitForExistence(timeout: 15))
    }
    if !app.otherElements["terminal"].exists {
      app.open(URL(string: "litch-dev://boot?mode=fixture")!)
      XCTAssertTrue(app.buttons["device:fixture"].waitForExistence(timeout: 15))
      let config = Bundle(for: Self.self).url(forResource: "validation", withExtension: "json")!
      let settings = try JSONSerialization.jsonObject(with: Data(contentsOf: config)) as! [String: String]
      app.open(URL(string: settings["terminal"]!)!)
    }
    XCTAssertTrue(app.otherElements["terminal"].waitForExistence(timeout: 10))
    let input = app.webViews.textViews["Terminal input"]
    XCTAssertTrue(input.waitForExistence(timeout: 10))
    if !app.keyboards.firstMatch.exists { app.buttons["terminal:key:keyboard"].tap() }
    let keyboardShown = app.keyboards.firstMatch.waitForExistence(timeout: 10)
    if !keyboardShown { print("LITCH_KEYBOARD_FAILURE \(app.debugDescription)") }
    XCTAssertTrue(keyboardShown)
    if app.buttons["Continue"].exists { app.buttons["Continue"].tap() }
    let globe = app.buttons.matching(NSPredicate(format: "label == %@ OR label == %@", "Next keyboard", "下一个键盘")).firstMatch
    // 每个普通输入用例从英文键盘开始；拼音候选用例自己切换，不能污染后面的输入。
    for _ in 0..<3 {
      if !(globe.value as? String ?? "").contains("English") { break }
      globe.tap()
    }
  }

  override func tearDown() {
    // XCTest 断言提前结束也要恢复方向，否则后续 Maestro 的手势坐标会沿用横屏。
    XCUIDevice.shared.orientation = .portrait
  }

  func testIndividualCharacters() throws {
    let command = "echo Ab_9-$((6*7))"
    for character in command {
      app.typeText(String(character))
    }
    app.typeText("\r")
    XCTAssertTrue(try commandWasReceived(command))
  }

  func testTerminalRotation() throws {
    defer { XCUIDevice.shared.orientation = .portrait }
    XCUIDevice.shared.orientation = .landscapeLeft
    let landscape = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
      self.app.frame.width > self.app.frame.height
    }, object: app)
    wait(for: [landscape], timeout: 10)
    XCTAssertTrue(app.buttons["terminal:key:keyboard"].isHittable)
    XCTAssertTrue(app.buttons["terminal:key:paste"].isHittable)
    XCTAssertTrue(app.keyboards.firstMatch.exists)
    XCTAssertLessThanOrEqual(app.buttons["terminal:key:paste"].frame.maxY, app.keyboards.firstMatch.frame.minY)
    for character in "echo landscape" { app.typeText(String(character)) }
    app.typeText("\r")
    XCTAssertTrue(try commandWasReceived("echo landscape"))
    app.buttons["header:back"].tap()
    let portrait = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
      self.app.frame.width < self.app.frame.height
    }, object: app)
    wait(for: [portrait], timeout: 10)
    XCTAssertTrue(app.otherElements["devices"].exists)
  }

  func testSystemPaste() throws {
    _ = try request("/clipboard/set", method: "POST", body: "echo e2e-$((6*7)) > e2e-mark.txt")
    app.buttons["terminal:key:paste"].tap()
    let allow = XCUIApplication(bundleIdentifier: "com.apple.springboard").buttons.matching(
      NSPredicate(format: "label == %@ OR label == %@", "Allow Paste", "允许粘贴")
    ).firstMatch
    if allow.waitForExistence(timeout: 2) { allow.tap() }
    app.typeText("\r")
    XCTAssertTrue(try commandWasReceived("echo e2e-$((6*7)) > e2e-mark.txt"))
    XCTAssertEqual(try evidence()["file"] as? String, "e2e-42\n")
  }

  func testDeniedPaste() throws {
    _ = try request("/clipboard/set", method: "POST", body: "echo denied-paste")
    let before = try evidence()["commands"] as? String
    app.buttons["terminal:key:paste"].tap()
    let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
    let deny = springboard.buttons.matching(
      NSPredicate(format: "label == %@ OR label == %@ OR label == %@", "不允许粘贴", "Don’t Allow Paste", "Don't Allow Paste")
    ).firstMatch
    XCTAssertTrue(deny.waitForExistence(timeout: 5))
    deny.tap()
    XCTAssertEqual(try evidence()["commands"] as? String, before)
    XCTAssertEqual(app.alerts.count, 0)
  }

  func testEmptyPaste() throws {
    _ = try request("/clipboard/set", method: "POST")
    let before = try evidence()["commands"] as? String
    app.buttons["terminal:key:paste"].tap()
    XCTAssertEqual(try evidence()["commands"] as? String, before)
    XCTAssertEqual(app.alerts.count, 0)
  }

  func testChineseComposition() throws {
    let globe = app.buttons.matching(
      NSPredicate(format: "label == %@ OR label == %@", "Next keyboard", "下一个键盘")
    ).firstMatch
    XCTAssertTrue(globe.exists)
    // 专用模拟器只有简体拼音与 English (US)；按钮 value 表示下一种键盘。
    for _ in 0..<3 {
      if (globe.value as? String ?? "").contains("English") { break }
      globe.tap()
      if app.buttons["Continue"].exists { app.buttons["Continue"].tap() }
    }
    XCTAssertTrue((globe.value as? String ?? "").contains("English"))
    for key in ["n", "i", "h", "a", "o"] { app.keys[key].tap() }
    let candidate = app.descendants(matching: .any).matching(
      NSPredicate(format: "label == %@", "你好")
    ).firstMatch
    XCTAssertTrue(candidate.waitForExistence(timeout: 5))
    candidate.tap()
    app.typeText("\r")
    XCTAssertTrue(try commandWasReceived("你好"))
  }

  func testBackgroundReconnect() throws {
    _ = try request("/background/start", method: "POST")
    defer { _ = try? request("/background/resume", method: "POST") }
    var paused = false
    for _ in 0..<33 {
      let state = try jsonRequest("/background/status")
      if state["paused"] as? Bool == true { paused = true; break }
    }
    XCTAssertTrue(paused, "系统期限或五分钟期限必须关闭后台连接")
    let state = try jsonRequest("/background/resume", method: "POST")
    XCTAssertEqual(state["resumed"] as? Bool, true)
    app.activate()
    if !app.keyboards.firstMatch.exists { app.buttons["terminal:key:keyboard"].tap() }
    XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 10))
    for character in "echo foreground" { app.typeText(String(character)) }
    app.typeText("\r")
    XCTAssertTrue(try commandWasReceived("echo foreground"))
  }

  private func request(_ path: String, method: String = "GET", body: String? = nil) throws -> Data {
    let config = Bundle(for: Self.self).url(forResource: "validation", withExtension: "json")!
    let settings = try JSONSerialization.jsonObject(with: Data(contentsOf: config)) as! [String: String]
    let done = expectation(description: "隔离 shell 命令与文件证据")
    var result: Data?
    var failure: Error?
    var request = URLRequest(url: URL(string: settings["helper"]! + path)!)
    request.httpMethod = method
    request.httpBody = body.map { Data($0.utf8) }
    URLSession.shared.dataTask(with: request) { data, _, error in
      result = data
      failure = error
      done.fulfill()
    }.resume()
    wait(for: [done], timeout: 12)
    if let failure { throw failure }
    return result ?? Data()
  }

  private func jsonRequest(_ path: String, method: String = "GET") throws -> [String: Any] {
    try JSONSerialization.jsonObject(with: request(path, method: method)) as! [String: Any]
  }

  private func evidence() throws -> [String: Any] {
    try jsonRequest("/terminal-evidence")
  }

  private func commandWasReceived(_ expected: String) throws -> Bool {
    for _ in 0..<20 {
      let commands = try evidence()["commands"] as? String ?? ""
      if commands.components(separatedBy: "\n").contains(expected) { return true }
      Thread.sleep(forTimeInterval: 0.1)
    }
    return false
  }
}
