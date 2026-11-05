import XCTest

// 实际配对、系统模拟 Face ID 与签名批准；不填入任何真实网站账号或密码。
final class PairingUITests: XCTestCase {
  private let app = XCUIApplication(bundleIdentifier: "dev.litch.app.dev")
  private var settings: [String: String] = [:]

  override func setUpWithError() throws {
    continueAfterFailure = false
    XCUIDevice.shared.orientation = .portrait
    let url = Bundle(for: Self.self).url(forResource: "validation", withExtension: "json")!
    settings = try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as! [String: String]
    _ = try request("/biometrics/enroll", post: true, body: Data("1".utf8))
    app.terminate()
    app.launch()
    XCTAssertTrue(app.otherElements["devices"].waitForExistence(timeout: 15))
    app.open(URL(string: "litch-dev://boot?mode=stored")!)
    XCTAssertTrue(app.buttons["devices:empty:add"].waitForExistence(timeout: 15))
    app.open(URL(string: settings["remote"]!)!)
  }

  func testPairAndSignedApproval() throws {
    app.buttons["devices:empty:add"].tap()
    app.buttons["add:pair"].tap()
    let payload = try request("/pair", post: true)
    _ = try request("/clipboard/set", post: true, body: payload)
    let paste = app.buttons.matching(NSPredicate(format: "label == %@ OR label == %@", "从剪贴板粘贴", "Paste from clipboard")).firstMatch
    for _ in 0..<4 {
      if paste.isHittable { break }
      app.swipeUp()
    }
    paste.tap()
    let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
    let allowPaste = springboard.buttons.matching(NSPredicate(format: "label == %@ OR label == %@", "允许粘贴", "Allow Paste")).firstMatch
    if allowPaste.waitForExistence(timeout: 2) { allowPaste.tap() }
    app.buttons["pair:paste:go"].tap()
    XCTAssertTrue(app.buttons["pair:add"].waitForExistence(timeout: 10))
    app.buttons["pair:add"].tap()
    XCTAssertTrue(app.staticTexts["pair:code"].waitForExistence(timeout: 20))
    let phone = try json(request("/pair/request"))
    let code = phone["code"] as! String
    XCTAssertEqual(app.staticTexts["pair:code"].label, String(code.prefix(3)) + " " + String(code.suffix(3)))
    _ = try request("/pair/allow", post: true)
    XCTAssertTrue(app.otherElements["sessions:list"].waitForExistence(timeout: 45))
    app.buttons["sessions:new"].tap()
    let input = app.textViews["new-input"].exists ? app.textViews["new-input"] : app.textFields["new-input"]
    input.tap()
    input.typeText("hello approval")
    app.buttons["new-send"].tap()
    XCTAssertTrue(app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", "收到：hello approval")).firstMatch.waitForExistence(timeout: 45))
    _ = try request("/approval/open", post: true)
    let account = app.descendants(matching: .any).matching(identifier: "request:signIn:account:a2").firstMatch
    XCTAssertTrue(account.waitForExistence(timeout: 15))
    for _ in 0..<4 {
      if account.isHittable { break }
      app.swipeUp()
    }
    account.tap()
    app.buttons["request:signIn:approve"].tap()
    let permission = app.alerts.buttons.matching(NSPredicate(format: "label == %@ OR label == %@ OR label == %@", "好", "允许", "OK")).firstMatch
    if permission.waitForExistence(timeout: 2) { permission.tap() }
    let face = NSPredicate(format: "label MATCHES %@", ".*(Face ID|面容 ?ID).*")
    let systemFace = springboard.descendants(matching: .any).matching(face).firstMatch
    let appFace = app.descendants(matching: .any).matching(face).firstMatch
    XCTAssertTrue(systemFace.waitForExistence(timeout: 3) || appFace.waitForExistence(timeout: 3))
    _ = try request("/biometrics/match", post: true)
    let approved = try json(request("/approval/answered"))
    XCTAssertEqual(approved["verified"] as? Bool, true)
    XCTAssertEqual(approved["ref"] as? String, "a2")
    XCTAssertEqual(approved["decision"] as? String, "approve")
    _ = try request("/approval/open", post: true)
    let decline = app.buttons["request:signIn:decline"]
    XCTAssertTrue(decline.waitForExistence(timeout: 10))
    decline.tap()
    let declined = try json(request("/approval/answered"))
    XCTAssertEqual(declined["verified"] as? Bool, true)
    XCTAssertEqual(declined["decision"] as? String, "decline")
    app.open(URL(string: "litch-dev://home")!)
    let more = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@ AND identifier ENDSWITH %@", "device:", ":more")).firstMatch
    for _ in 0..<5 {
      if more.isHittable { break }
      app.swipeUp()
    }
    more.tap()
    app.buttons["menu:remove"].tap()
    app.buttons["confirm:ok"].tap()
    XCTAssertTrue(app.buttons["devices:empty:add"].waitForExistence(timeout: 20))
    let remaining = try json(request("/pair/phones"))
    XCTAssertEqual(remaining["phones"] as? Int, 0)
    XCTAssertEqual(remaining["keyLines"] as? Int, 0)
  }

  private func json(_ data: Data) throws -> [String: Any] {
    try JSONSerialization.jsonObject(with: data) as! [String: Any]
  }

  private func request(_ path: String, post: Bool = false, body: Data? = nil) throws -> Data {
    let done = expectation(description: "隔离配对与批准")
    var result = Data()
    var failure: Error?
    var request = URLRequest(url: URL(string: settings["helper"]! + path)!)
    request.httpMethod = post ? "POST" : "GET"
    request.httpBody = body
    request.timeoutInterval = 75
    URLSession.shared.dataTask(with: request) { data, _, error in
      result = data ?? Data()
      failure = error
      done.fulfill()
    }.resume()
    wait(for: [done], timeout: 80)
    if let failure { throw failure }
    return result
  }
}
