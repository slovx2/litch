import XCTest

// 完整私钥只来自临时 sshd；用原生元素核对多行输入、首次导入点击和真实 SSH 连接。
final class ManualSshUITests: XCTestCase {
  private let app = XCUIApplication(bundleIdentifier: "dev.litch.app.dev")

  func testImportPrivateKeyAndConnect() throws {
    continueAfterFailure = false
    XCUIDevice.shared.orientation = .portrait
    let file = Bundle(for: Self.self).url(forResource: "validation", withExtension: "json")!
    let config = try JSONSerialization.jsonObject(with: Data(contentsOf: file)) as! [String: String]
    let target = try JSONSerialization.jsonObject(with: Data(config["target"]!.utf8)) as! [String: Any]
    app.launch()
    XCTAssertTrue(app.otherElements["devices"].waitForExistence(timeout: 15))
    app.open(URL(string: config["remote"]!)!)
    app.buttons["devices:empty:add"].tap()
    fill("add:host", target["host"] as! String)
    fill("add:port", String(target["port"] as! Int), replace: true)
    fill("add:user", target["user"] as! String)
    let importButton = app.buttons["key:import"]
    reveal(importButton)
    importButton.tap()
    let privateKey = target["privateKey"] as! String
    let input = app.textViews["key:paste"]
    XCTAssertTrue(input.waitForExistence(timeout: 5))
    input.tap()
    input.typeText(privateKey)
    XCTAssertEqual(input.value as? String, privateKey)
    XCTAssertTrue(app.keyboards.firstMatch.exists)
    let submit = app.buttons["key:doImport"]
    XCTAssertTrue(submit.isEnabled)
    // 不先收键盘，首次按元素点击必须完成导入。
    submit.tap()
    let copied = app.buttons["key:copy"]
    let imported = copied.waitForExistence(timeout: 10)
    if !imported { print("LITCH_IMPORT_FAILURE \(app.debugDescription)") }
    XCTAssertTrue(imported)
    XCTAssertFalse(app.staticTexts["key:error"].exists)
    let check = app.buttons["add:check"]
    reveal(check)
    check.tap()
    XCTAssertTrue(app.buttons["confirm:ok"].waitForExistence(timeout: 15))
    let fingerprint = app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", target["hostFingerprint"] as! String)).firstMatch
    XCTAssertTrue(fingerprint.exists)
    app.buttons["confirm:ok"].tap()
    XCTAssertTrue(app.descendants(matching: .any)["check:service"].waitForExistence(timeout: 45))
    let add = app.buttons["add:submit"]
    reveal(add)
    add.tap()
    XCTAssertTrue(app.otherElements["sessions:list"].waitForExistence(timeout: 45))
    XCTAssertFalse(app.descendants(matching: .any)["sessions:failure"].exists)
  }

  private func fill(_ id: String, _ value: String, replace: Bool = false) {
    let input = app.textFields[id]
    XCTAssertTrue(input.waitForExistence(timeout: 5))
    input.tap()
    if replace {
      input.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: (input.value as? String ?? "").count))
    }
    input.typeText(value)
    XCTAssertEqual(input.value as? String, value)
    app.buttons["keyboard:done"].tap()
  }

  private func reveal(_ element: XCUIElement) {
    for _ in 0..<6 {
      if element.exists && element.isHittable { return }
      if element.exists && element.frame.midY < app.frame.midY { app.swipeDown() }
      else { app.swipeUp() }
    }
    XCTAssertTrue(element.isHittable)
  }
}
