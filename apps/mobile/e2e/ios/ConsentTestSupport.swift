import XCTest

extension XCUIApplication {
  // 普通原生回归先完成真实首次告知，不预写许可。隐私专项自己验证拒绝与恢复。
  func agreeToLaunchConsentIfNeeded() {
    let allow = buttons["ai-consent:allow"]
    let ready = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
      allow.exists || self.otherElements["devices"].exists || self.otherElements["terminal"].exists
    }, object: self)
    XCTAssertEqual(XCTWaiter.wait(for: [ready], timeout: 30), .completed)
    if allow.exists {
      for _ in 0..<8 {
        if allow.isHittable { break }
        swipeUp()
      }
      XCTAssertTrue(allow.isHittable)
      allow.tap()
      let closed = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in !allow.exists }, object: self)
      XCTAssertEqual(XCTWaiter.wait(for: [closed], timeout: 10), .completed)
    }
  }
}
