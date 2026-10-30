import XCTest
@testable import LitchComputerUseCore

final class SavePanelGuidanceTests: XCTestCase {
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
