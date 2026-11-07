// 专用模拟器上卸载、重装开发验收包，保证首次启动没有旧许可；只连接模拟核心。
import XCTest

final class DiscussionConsentTests: XCTestCase {
  private let app = XCUIApplication(bundleIdentifier: "dev.litch.app.dev")

  private func button(_ id: String) -> XCUIElement { app.buttons[id] }

  private func tap(_ id: String) {
    let target = button(id)
    XCTAssertTrue(target.waitForExistence(timeout: 20), id)
    for _ in 0..<8 {
      if target.isHittable { break }
      app.swipeUp()
    }
    XCTAssertTrue(target.isHittable, id)
    target.tap()
  }

  private func sent(_ field: XCUIElement, _ text: String) {
    let cleared = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
      field.exists && (field.value as? String) != text
    }, object: field)
    wait(for: [cleared], timeout: 15)
    XCTAssertFalse(button("ai-consent:allow").exists)
    XCTAssertFalse(button("ai-consent:review").exists)
  }

  func testLaunchConsentAndDraftRecovery() {
    continueAfterFailure = false
    XCUIDevice.shared.orientation = .portrait
    app.launch()
    // 告知先于任何设备/发送操作；切后台再回来不等于拒绝。
    XCTAssertTrue(button("ai-consent:allow").waitForExistence(timeout: 30))
    XCUIDevice.shared.press(.home)
    app.activate()
    XCTAssertTrue(button("ai-consent:allow").waitForExistence(timeout: 10))
    tap("ai-consent:cancel")
    app.terminate()
    app.launch()
    XCTAssertTrue(app.otherElements["devices"].waitForExistence(timeout: 20))
    XCTAssertFalse(button("ai-consent:allow").exists)
    app.open(URL(string: "litch-dev://boot?mode=mock&controlled=1")!)
    XCTAssertTrue(button("device:local").waitForExistence(timeout: 20))
    app.open(URL(string: "litch-dev://open?device=local&session=p2")!)
    let composer = app.textViews["composer-input"]
    XCTAssertTrue(composer.waitForExistence(timeout: 20))
    composer.tap()
    app.typeText("Draft without consent")
    tap("composer-send")
    XCTAssertTrue(button("ai-consent:review").waitForExistence(timeout: 10))
    tap("ai-consent:cancel")
    XCTAssertEqual(composer.value as? String, "Draft without consent")
    XCTAssertFalse(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "Cancelled")).firstMatch.exists)
    tap("composer-send")
    tap("ai-consent:review")
    tap("ai-consent:allow")
    // 许可不自动重放先前的操作，也不清空草稿。
    XCTAssertEqual(composer.value as? String, "Draft without consent")
    tap("composer-send")
    sent(composer, "Draft without consent")
    composer.tap()
    app.typeText("Second message without interruption")
    tap("composer-send")
    sent(composer, "Second message without interruption")
    app.terminate()
    app.launch()
    XCTAssertTrue(app.descendants(matching: .any).matching(identifier: "devices").firstMatch.waitForExistence(timeout: 20))
    XCTAssertFalse(button("ai-consent:allow").exists)

    // 经理讨论中的临时对话和另一个 harness 也沿用首次选择。
    tap("devices:managers")
    tap("manager:m1")
    app.descendants(matching: .any).matching(identifier: "manager-tab:console").firstMatch.tap()
    tap("post-discussion:D-17")
    app.buttons.matching(NSPredicate(format: "label IN %@", ["Temporary chat", "临时对话"])).firstMatch.tap()
    let field = app.textViews["post-question:D-17"]
    XCTAssertTrue(field.waitForExistence(timeout: 10))
    field.tap()
    app.typeText("Discussion without interruption")
    tap("post-question-submit:D-17")
    sent(field, "Discussion without interruption")
    tap("discussion-drawer:close")

    // 设置撤回后仍保留讨论草稿，提示由当前 Modal 承载，不能藏在抽屉下面。
    app.open(URL(string: "litch-dev://home")!)
    tap("devices:settings")
    tap("settings:withdraw-consent")
    tap("confirm:ok")
    tap("header:back")
    tap("devices:managers")
    tap("manager:m1")
    app.descendants(matching: .any).matching(identifier: "manager-tab:console").firstMatch.tap()
    tap("post-discussion:D-17")
    XCTAssertTrue(field.waitForExistence(timeout: 10))
    field.tap()
    app.typeText("Withdrawn discussion draft")
    tap("post-question-submit:D-17")
    tap("ai-consent:review")
    tap("ai-consent:cancel")
    XCTAssertEqual(field.value as? String, "Withdrawn discussion draft")
  }
}
