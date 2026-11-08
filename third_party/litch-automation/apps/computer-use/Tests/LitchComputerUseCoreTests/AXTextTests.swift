import XCTest

@testable import LitchComputerUseCore

final class AXTextTests: XCTestCase {
  private func window(_ children: [AXNode]) -> AXNode {
    AXNode(role: "AXWindow", title: "Doc", children: children)
  }

  func testRenderIndentsAndSkipsUnlabeledContainers() {
    var book = AXIndexBook()
    let tree = window([
      AXNode(
        role: "AXGroup",
        children: [
          AXNode(role: "AXButton", title: "Save", states: ["disabled"]),
          AXNode(role: "AXTextField", title: "Name", value: "Ann", states: ["focused"]),
        ]),
      AXNode(role: "AXGroup", title: "Sidebar", children: [AXNode(role: "AXStaticText", value: "Hi")]),
    ])
    let text = AXText.render(book.lines(for: tree))
    XCTAssertEqual(
      text,
      """
      [1] Window "Doc"
        [2] Button "Save" {disabled}
        [3] TextField "Name" = "Ann" {focused}
        [4] Group "Sidebar"
          [5] StaticText = "Hi"
      """)
  }

  func testIndicesStableAcrossSnapshotsAndNotReused() {
    var book = AXIndexBook()
    let first = book.lines(
      for: window([
        AXNode(role: "AXButton", title: "A"), AXNode(role: "AXButton", title: "B"),
      ]))
    XCTAssertEqual(first.map(\.index), [1, 2, 3])
    book.remember(first)
    // B 消失、新来 C，A 的值变了
    let second = book.lines(
      for: window([
        AXNode(role: "AXButton", title: "A", value: "x"), AXNode(role: "AXButton", title: "C"),
      ]))
    XCTAssertEqual(second.map(\.index), [1, 2, 4])
    let diff = AXText.diff(previous: book.previous, current: second)
    XCTAssertEqual(
      diff,
      """
      ~ [2] Button "A" = "x"
      + [4] Button "C"
      - [3] Button "B"
      """)
    book.remember(second)
    // B 又回来了，拿的是新号，不是 3
    let third = book.lines(
      for: window([AXNode(role: "AXButton", title: "A"), AXNode(role: "AXButton", title: "B")]))
    XCTAssertEqual(third.map(\.index), [1, 2, 5])
  }

  func testSameNamedSiblingsAreDistinguished() {
    var book = AXIndexBook()
    let lines = book.lines(
      for: window([
        AXNode(role: "AXButton", title: "OK"), AXNode(role: "AXButton", title: "OK"),
      ]))
    XCTAssertEqual(Set(lines.map(\.index)).count, 3)
  }

  func testIdentifierBeatsTitleForIdentity() {
    var book = AXIndexBook()
    let first = book.lines(for: window([AXNode(role: "AXButton", title: "Play", identifier: "toggle")]))
    book.remember(first)
    let second = book.lines(for: window([AXNode(role: "AXButton", title: "Pause", identifier: "toggle")]))
    XCTAssertEqual(first.last?.index, second.last?.index)
    XCTAssertEqual(
      AXText.diff(previous: book.previous, current: second), "~ [2] Button \"Pause\"")
  }

  func testNoChanges() {
    var book = AXIndexBook()
    let tree = window([AXNode(role: "AXButton", title: "A")])
    book.remember(book.lines(for: tree))
    XCTAssertEqual(
      AXText.diff(previous: book.previous, current: book.lines(for: tree)),
      "(no changes since the last state)")
  }

  func testNoPreviousMeansNoDiff() {
    var book = AXIndexBook()
    XCTAssertNil(AXText.diff(previous: book.previous, current: book.lines(for: window([]))))
    book.remember(book.lines(for: window([])))
    book.forget()
    XCTAssertNil(book.previous)
  }

  func testCutAtLineBoundary() {
    var book = AXIndexBook()
    let many = (0..<50).map { AXNode(role: "AXStaticText", value: "line number \($0)") }
    let text = AXText.render(book.lines(for: window(many)), limit: 200)
    XCTAssertLessThanOrEqual(text.split(separator: "\n").dropLast().joined(separator: "\n").count, 200)
    XCTAssertTrue(text.hasSuffix("more lines not shown)"), text)
    XCTAssertFalse(text.contains("line numb\n"))
  }

  func testQuotingAndLongValues() {
    let node = AXNode(role: "AXTextArea", value: "a \"q\"\nb" + String(repeating: "x", count: 400))
    let described = AXText.describe(node)
    XCTAssertTrue(described.hasPrefix("TextArea = \"a \\\"q\\\"\\nb"), described)
    XCTAssertTrue(described.hasSuffix("…\""))
  }
}
