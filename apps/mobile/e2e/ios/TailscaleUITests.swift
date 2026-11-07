import XCTest

final class TailscaleUITests: XCTestCase {
  private let app = XCUIApplication(bundleIdentifier: "dev.litch.app.dev")
  private var settings: [String: String] = [:]

  override func setUpWithError() throws {
    continueAfterFailure = false
    XCUIDevice.shared.orientation = .portrait
    let url = Bundle(for: Self.self).url(forResource: "validation", withExtension: "json")!
    settings = try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as! [String: String]
    app.terminate()
    app.launch()
    app.agreeToLaunchConsentIfNeeded()
    XCTAssertTrue(app.wait(for: .runningForeground, timeout: 15))
    XCTAssertTrue(app.otherElements["devices"].waitForExistence(timeout: 15))
    app.open(URL(string: "litch-dev://boot?mode=fixture")!)
    XCTAssertTrue(app.buttons["device:fixture"].waitForExistence(timeout: 15))
  }

  override func tearDown() {
    if (testRun?.failureCount ?? 0) > 0 { print("LITCH_NETWORK_UI_FAILURE \(app.debugDescription)") }
  }

  func testTailscaleSettingsAndBackground() throws {
    app.buttons["devices:settings"].tap()
    let entry = app.buttons["settings:tailscale"]
    for _ in 0..<6 {
      if entry.isHittable { break }
      app.swipeUp()
    }
    XCTAssertTrue(entry.isHittable)
    entry.tap()
    let state = app.staticTexts["tailscale:state"]
    XCTAssertTrue(state.waitForExistence(timeout: 10))
    XCTAssertFalse(app.staticTexts["tailscale:unavailable"].exists)
    try action("clear")
    app.buttons["tailscale:advanced"].tap()
    let control = app.textFields["tailscale:control"]
    XCTAssertTrue(control.waitForExistence(timeout: 5))
    control.tap()
    let existing = control.value as? String ?? ""
    control.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: existing.count))
    control.typeText(settings["controlURL"]! + "\n")
    app.buttons["tailscale:login"].tap()
    connected(state)
    _ = try request("/background/start", post: true)
    defer { _ = try? request("/background/resume", post: true) }
    var suspended = false
    for _ in 0..<5 {
      let value = try JSONSerialization.jsonObject(with: request("/background/status")) as! [String: Any]
      if value["paused"] as? Bool == true { suspended = true; break }
    }
    XCTAssertTrue(suspended)
    _ = try request("/background/resume", post: true)
    app.activate()
    connected(state)
    try action("logout")
    disconnected(state)
    app.buttons["tailscale:login"].tap()
    connected(state)
    try action("clear")
    disconnected(state)
    XCTAssertFalse(app.staticTexts["tailscale:error"].exists)
  }

  func testTailscaleSwitchAccessibility() throws {
    app.buttons["devices:add"].tap()
    try inspectSwitch(toggle: true)
    app.buttons["header:back"].tap()
    // 设备详情复用同一控件；夹具设备已有真实 SSH 通道。
    let more = app.buttons["device:fixture:more"]
    XCTAssertTrue(more.waitForExistence(timeout: 10))
    more.tap()
    app.buttons["menu:detail"].tap()
    try inspectSwitch(toggle: false)
    app.buttons["header:back"].tap()
    app.buttons["devices:add"].tap()
    app.buttons["add:pair"].tap()
    let payload = try request("/pair", post: true)
    _ = try request("/clipboard/set", post: true, body: payload)
    let paste = app.buttons.matching(NSPredicate(format: "label == %@ OR label == %@", "从剪贴板粘贴", "Paste from clipboard")).firstMatch
    for _ in 0..<4 {
      if paste.isHittable { break }
      app.swipeUp()
    }
    paste.tap()
    let allow = XCUIApplication(bundleIdentifier: "com.apple.springboard").buttons.matching(NSPredicate(format: "label == %@ OR label == %@", "允许粘贴", "Allow Paste")).firstMatch
    if allow.waitForExistence(timeout: 2) { allow.tap() }
    app.buttons["pair:paste:go"].tap()
    try inspectSwitch(toggle: true)
  }

  private func inspectSwitch(toggle: Bool) throws {
    let control = app.buttons["tailscale:mode"]
    XCTAssertTrue(control.waitForExistence(timeout: 10))
    XCTAssertTrue(control.isHittable)
    if toggle {
      control.tap()
      app.buttons["tailscale:mode:always"].tap()
      XCTAssertTrue(control.label.contains("总是") || control.label.contains("Always"))
    }
  }

  private func action(_ name: String) throws {
    let button = app.buttons["tailscale:\(name)"]
    for _ in 0..<4 {
      if button.isHittable { break }
      app.swipeUp()
    }
    XCTAssertTrue(button.isHittable)
    button.tap()
    let confirm = app.buttons["confirm:ok"]
    XCTAssertTrue(confirm.waitForExistence(timeout: 5))
    confirm.tap()
    XCTAssertTrue(app.staticTexts["tailscale:state"].waitForExistence(timeout: 10))
  }

  private func connected(_ element: XCUIElement) {
    let done = XCTNSPredicateExpectation(predicate: NSPredicate(format: "label == %@ OR label == %@", "已连接", "Connected"), object: element)
    wait(for: [done], timeout: 30)
  }

  private func disconnected(_ element: XCUIElement) {
    let done = XCTNSPredicateExpectation(predicate: NSPredicate(format: "label == %@ OR label == %@", "未连接", "Disconnected"), object: element)
    wait(for: [done], timeout: 15)
  }

  private func request(_ path: String, post: Bool = false, body: Data? = nil) throws -> Data {
    let done = expectation(description: "后台连接状态")
    var result = Data()
    var failure: Error?
    var request = URLRequest(url: URL(string: settings["helper"]! + path)!)
    request.httpMethod = post ? "POST" : "GET"
    request.httpBody = body
    URLSession.shared.dataTask(with: request) { data, _, error in
      result = data ?? Data()
      failure = error
      done.fulfill()
    }.resume()
    wait(for: [done], timeout: 15)
    if let failure { throw failure }
    return result
  }
}
