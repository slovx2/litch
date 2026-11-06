// 在已安装 Litch Dev 验收包的专用模拟器上跑；只用模拟核心，不占 Maestro 的 7001 端口。
// 同时比较输入框、所属卡片视口和键盘的原生边界，避免只看文字节点存在而漏掉裁切。
import XCTest

final class QuestionKeyboardTests: XCTestCase {
  private let app = XCUIApplication(bundleIdentifier: "dev.litch.app.dev")

  override func setUpWithError() throws {
    continueAfterFailure = false
    XCUIDevice.shared.orientation = .portrait
    app.terminate()
    app.launch()
    XCTAssertTrue(app.otherElements["devices"].waitForExistence(timeout: 20))
    app.open(URL(string: "litch-dev://boot?mode=mock")!)
    XCTAssertTrue(app.buttons["device:local"].waitForExistence(timeout: 20))
  }

  private func open(_ session: String, device: String) {
    app.open(URL(string: "litch-dev://open?session=\(session)&device=\(device)")!)
  }

  private func reveal(_ element: XCUIElement, in card: XCUIElement) {
    XCTAssertTrue(card.waitForExistence(timeout: 15))
    let body = card.scrollViews.firstMatch
    for _ in 0..<6 {
      if element.exists && element.isHittable && body.frame.contains(element.frame) { return }
      body.swipeUp()
    }
    XCTAssertTrue(element.isHittable)
  }

  private func verify(_ field: XCUIElement, in card: XCUIElement, name: String) {
    XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 10))
    if app.buttons["Continue"].exists { app.buttons["Continue"].tap() }
    let body = card.scrollViews.firstMatch
    let visible = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
      guard field.exists && body.exists else { return false }
      let box = field.frame
      let viewport = body.frame
      return box.height >= 38 && box.minY >= viewport.minY - 1 &&
        box.maxY <= viewport.maxY + 1 &&
        box.maxY <= self.app.keyboards.firstMatch.frame.minY
    }, object: field)
    wait(for: [visible], timeout: 10)
    print("QUESTION_RECT \(name) input=\(field.frame) viewport=\(body.frame) keyboard=\(app.keyboards.firstMatch.frame)")
    let shot = XCTAttachment(screenshot: app.screenshot())
    shot.name = name
    shot.lifetime = .keepAlways
    add(shot)
  }

  func testQuestionAndMultiline() {
    open("b1", device: "build")
    let card = app.otherElements["request:question"]
    let other = app.descendants(matching: .any).matching(identifier: "request:pick:other").firstMatch
    reveal(other, in: card)
    other.tap()
    let field = app.textViews["request:other"]
    XCTAssertTrue(field.waitForExistence(timeout: 10))
    // 用 app.typeText，不能让 XCTest 的 field.typeText 替产品滚动输入框。
    app.typeText("visible question answer")
    XCTAssertEqual(field.value as? String, "visible question answer")
    verify(field, in: card, name: "question")
    app.typeText("\nsecond line\nthird line\nfourth line\nfifth line")
    XCTAssertTrue((field.value as? String ?? "").contains("fifth line"))
    verify(field, in: card, name: "question-multiline")
  }

  func testApproval() {
    open("s2", device: "local")
    let card = app.otherElements["request:approval"]
    let note = app.buttons["request:note-open"]
    reveal(note, in: card)
    note.tap()
    let field = app.textViews["request:note"]
    XCTAssertTrue(field.waitForExistence(timeout: 10))
    app.typeText("visible approval note")
    XCTAssertEqual(field.value as? String, "visible approval note")
    verify(field, in: card, name: "approval")
  }

  func testPending() {
    open("s3", device: "local")
    let composer = app.textViews["composer-input"]
    XCTAssertTrue(composer.waitForExistence(timeout: 10))
    composer.tap()
    app.typeText("ask while working")
    app.buttons["composer-send"].tap()
    let consent = app.buttons["ai-consent:allow"]
    if consent.waitForExistence(timeout: 3) { consent.tap() }
    let card = app.otherElements["pending-questions"]
    XCTAssertTrue(card.waitForExistence(timeout: 20))
    let field = app.textViews.matching(NSPredicate(format: "identifier BEGINSWITH %@", "pending:")).firstMatch
    reveal(field, in: card)
    field.tap()
    app.typeText("visible pending answer")
    XCTAssertEqual(field.value as? String, "visible pending answer")
    verify(field, in: card, name: "pending")
  }
}
