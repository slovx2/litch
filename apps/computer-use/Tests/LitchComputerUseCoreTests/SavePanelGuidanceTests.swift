import XCTest
@testable import LitchComputerUseCore

final class SavePanelGuidanceTests: XCTestCase {
  func testFilenameNumberSurvivesLongDirectoryTextAndIsNotGuessed() {
    var root = panel()
    root.children[1].identifier = "saveAsNameTextField"
    root.children[1].handle = 42
    root.children.insert(AXNode(role: "AXList", children: (0..<500).map {
      AXNode(role: "AXTextField", value: "directory-entry-\($0)", handle: 100 + $0)
    }), at: 0)
    var book = AXIndexBook()
    let lines = book.lines(for: root)
    XCTAssertFalse(AXText.render(lines, limit: 1000).contains("Untitled"))
    let line = lines.first { $0.handle == 42 }!
    XCTAssertTrue(SavePanelGuidance.filenameControl(root, lines: lines).contains("[\(line.index)]"))
    XCTAssertEqual(SavePanelGuidance.filenameControl(root, lines: []), "")
  }

  func panel(english: Bool = false, filename: String = "Untitled", role: String = "AXSheet") -> AXNode {
    AXNode(role: role, title: english ? "Save" : "保存", children: [
      AXNode(role: "AXStaticText", value: english ? "Save As:" : "保存为："),
      AXNode(role: "AXTextField", value: filename),
      AXNode(role: "AXButton", title: english ? "Save" : "保存"),
    ])
  }

  func testObservedSavePanelExplainsFolderNavigationAndFilenameSeparately() {
    let root = AXNode(role: "AXGroup", children: [AXNode(role: "AXWindow", title: "Untitled", children: [panel()])])
    let note = SavePanelGuidance.note(root)
    XCTAssertTrue(note?.contains("cmd+shift+g") == true)
    XCTAssertTrue(note?.contains("only the filename") == true)
    XCTAssertTrue(note?.contains("verify the selected destination") == true)
    XCTAssertTrue(SavePanelGuidance.note(panel(english: true, role: "AXWindow"))?.contains("iCloud") == true)
  }

  func testGuidanceDoesNotTreatEverySlashFieldAsTheFilename() {
    var root = panel(filename: "cu-note.rtf")
    root.children.append(AXNode(role: "AXTextField", value: "/tmp/litch-cu-trial"))
    XCTAssertEqual(SavePanelGuidance.note(root), SavePanelGuidance.note(panel(filename: "/tmp/litch-cu-trial/cu-note.rtf")))
  }

  func testOrdinaryDocumentAndIncompleteDialogDoNotGetSaveInstructions() {
    var ordinary = panel(role: "AXWebArea")
    XCTAssertNil(SavePanelGuidance.note(ordinary))
    ordinary.role = "AXWindow"; ordinary.title = "My document"
    XCTAssertNil(SavePanelGuidance.note(ordinary))
    var missing = panel()
    missing.children.removeLast()
    XCTAssertNil(SavePanelGuidance.note(missing))
    missing = panel(); missing.children.removeFirst()
    XCTAssertNil(SavePanelGuidance.note(missing))
  }
}
