// 专用模拟器上先卸载、重装验收包，确保没有已保存的数据同意；只连接模拟核心。
import XCTest

final class DiscussionConsentTests: XCTestCase {
  private let app = XCUIApplication(bundleIdentifier: "dev.litch.app.dev")

  private func capture(_ name: String) {
    let shot = XCTAttachment(screenshot: app.screenshot())
    shot.name = name
    shot.lifetime = .keepAlways
    add(shot)
    print("DISCUSSION_TREE \(name)\n\(app.debugDescription)")
  }

  func testConsentInsideDiscussion() {
    continueAfterFailure = false
    XCUIDevice.shared.orientation = .portrait
    app.launch()
    XCTAssertTrue(app.otherElements["devices"].waitForExistence(timeout: 20))
    app.open(URL(string: "litch-dev://boot?mode=mock&controlled=1")!)
    let managers = app.buttons["devices:managers"]
    XCTAssertTrue(managers.waitForExistence(timeout: 20))
    managers.tap()
    app.buttons["manager:m1"].tap()
    app.descendants(matching: .any).matching(identifier: "manager-tab:console").firstMatch.tap()
    app.buttons["post-discussion:D-17"].tap()
    app.buttons.matching(NSPredicate(format: "label IN %@", ["Temporary chat", "临时对话"])).firstMatch.tap()
    let field = app.textViews["post-question:D-17"]
    XCTAssertTrue(field.waitForExistence(timeout: 10))
    field.tap()
    app.typeText("Temporary keyboard question")
    app.buttons["post-question-submit:D-17"].tap()

    let allow = app.buttons["ai-consent:allow"]
    let appeared = allow.waitForExistence(timeout: 10)
    capture("discussion-consent-first")
    XCTAssertTrue(appeared, "讨论抽屉打开时，同意框必须可见")
    XCTAssertTrue(allow.isHittable, "同意按钮必须能点")
    let cancel = app.buttons["ai-consent:cancel"]
    XCTAssertTrue(cancel.isHittable)
    cancel.tap()
    XCTAssertTrue(field.waitForExistence(timeout: 10))
    XCTAssertEqual(field.value as? String, "Temporary keyboard question")

    // 取消不得发送或丢草稿；第二次同意之后才清空。
    app.buttons["post-question-submit:D-17"].tap()
    XCTAssertTrue(allow.waitForExistence(timeout: 10))
    XCTAssertTrue(allow.isHittable)
    allow.tap()
    let cleared = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
      field.exists && (field.value as? String) != "Temporary keyboard question"
    }, object: field)
    wait(for: [cleared], timeout: 10)
    XCTAssertTrue(app.otherElements.matching(NSPredicate(format: "label == %@", "Temporary keyboard question")).firstMatch.waitForExistence(timeout: 10))
    capture("discussion-consent-complete")
    // 同一设备和工具的第二条追问沿用许可，不能再弹同意框；切换工具在下方另验。
    field.tap()
    app.typeText("Second question with saved consent")
    app.buttons["post-question-submit:D-17"].tap()
    let secondCleared = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
      field.exists && (field.value as? String) != "Second question with saved consent"
    }, object: field)
    wait(for: [secondCleared], timeout: 10)
    XCTAssertFalse(allow.exists)
    XCTAssertTrue(app.buttons["discussion-drawer:close"].isHittable)
    app.buttons["discussion-drawer:close"].tap()

    // 抽屉关闭后，主输入框仍由根节点显示另一服务的数据同意。
    app.open(URL(string: "litch-dev://open?device=local&session=s3")!)
    let composer = app.textViews["composer-input"]
    XCTAssertTrue(composer.waitForExistence(timeout: 10))
    composer.tap()
    app.typeText("Root consent after discussion")
    app.buttons["composer-send"].tap()
    XCTAssertTrue(allow.waitForExistence(timeout: 10))
    XCTAssertTrue(allow.isHittable)
    allow.tap()
    XCTAssertTrue(app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", "Root consent after discussion")).firstMatch.waitForExistence(timeout: 10))
    capture("root-consent-after-discussion")
  }
}
