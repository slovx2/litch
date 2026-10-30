import ApplicationServices
import XCTest
import LitchComputerUseCore
@testable import LitchComputerUse

final class KeyboardTargetTests: XCTestCase {
  func testRemotePlainKeysRequireProtectedForeground() {
    XCTAssertTrue(InputPolicy.keyboardNeedsForeground(hasWindow: true, flags: 0, remoteFocus: true))
    XCTAssertFalse(InputPolicy.keyboardNeedsForeground(hasWindow: true, flags: 0, remoteFocus: false))
    XCTAssertEqual(InputPolicy.waitResult(elapsed: 8, idle: 0, cancelled: false), "userActive")
    XCTAssertEqual(InputPolicy.waitResult(elapsed: 0, idle: 3, cancelled: true), "cancelled")
  }
  func testRemotePanelUsesActualPIDInsteadOfProxyOwner() throws {
    let proxy = AXUIElementCreateApplication(100)
    let pid = try KeyboardTarget.resolve(appPID: 100, focus: { proxy }, actual: { _ in 200 })
    XCTAssertEqual(pid, 200)
    var destinations: [pid_t] = []
    let io = Input.KeyboardIO(target: { _, pid in destinations.append(pid) },
      system: { _ in XCTFail("不应向系统广播") }, flags: { 0 }, revision: { 0 }, pause: {})
    try Input.key(Keys.parse("cmd+shift+g"), pid: pid, io: io)
    // 按下、松开和修饰键收尾必须到同一个实际目标。
    XCTAssertEqual(destinations, [200, 200, 200, 200])
  }

  func testOrdinaryFocusAndWindowlessMenuUseHost() throws {
    let proxy = AXUIElementCreateApplication(100)
    XCTAssertEqual(try KeyboardTarget.resolve(appPID: 100, focus: { proxy }, actual: { _ in 100 }), 100)
    XCTAssertEqual(try KeyboardTarget.resolve(appPID: 100, focus: { nil }, actual: { _ in
      XCTFail("无焦点时不调用实际 PID 查询"); return nil
    }), 100)
  }

  func testUnknownOrStaleRemotePIDFailsBeforeSending() {
    for value: pid_t? in [nil, 0, -1] {
      XCTAssertThrowsError(try KeyboardTarget.resolve(appPID: 100,
        focus: { AXUIElementCreateApplication(100) }, actual: { _ in value })) { error in
        XCTAssertEqual((error as? RPCError)?.kind, .failed)
        XCTAssertTrue((error as? RPCError)?.message.contains("no input was sent") == true)
      }
    }
  }

  func testNextActionResolvesChangedFocusAgain() throws {
    var current: pid_t = 200
    let focus = { AXUIElementCreateApplication(100) as AXUIElement? }
    XCTAssertEqual(try KeyboardTarget.resolve(appPID: 100, focus: focus, actual: { _ in current }), 200)
    current = 100
    XCTAssertEqual(try KeyboardTarget.resolve(appPID: 100, focus: focus, actual: { _ in current }), 100)
  }
}
