import AppKit
import XCTest
import LitchComputerUseCore
@testable import LitchComputerUse

final class InputRecoveryTests: XCTestCase {
  func testLostReleaseAfterFocusChangeIsReconciledWithoutNewConflict() {
    let pid: pid_t = 123456
    UserActivity.note(.keyDown, pid: pid, code: 12)
    UserActivity.note(.mouseDown, pid: pid, code: 4)
    let revision = UserActivity.targetRevision(pid: pid)
    // 模拟切焦点后 keyUp/mouseUp 没到监听器，硬件已经释放。
    let released = UserActivity.heldInput(keyDown: { _ in false }, buttonDown: { _ in false })
    XCTAssertFalse(released.blocked)
    XCTAssertFalse(released.pointer)
    XCTAssertEqual(UserActivity.targetRevision(pid: pid), revision)
    XCTAssertEqual(InputPolicy.waitResult(elapsed: 20, blocked: released.blocked, cancelled: false), "ready")
  }

  func testLiveHeldInputWinsEvenIfPressEventWasMissed() {
    let held = UserActivity.heldInput(keyDown: { $0 == 54 }, buttonDown: { $0 == 4 })
    XCTAssertTrue(held.blocked)
    XCTAssertTrue(held.pointer)
    let capsOnly = UserActivity.heldInput(keyDown: { $0 == 57 }, buttonDown: { _ in false })
    XCTAssertFalse(capsOnly.blocked, "Caps Lock 锁定不等于持续按住")
  }

  func testHiddenNativeFocusAndCompositionCanFinishWithoutShowingWindow() {
    _ = NSApplication.shared
    let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 320, height: 180),
      styleMask: [.borderless], backing: .buffered, defer: false)
    window.isReleasedWhenClosed = false
    defer { window.close() }
    let first = NSTextView(frame: NSRect(x: 0, y: 0, width: 150, height: 180))
    let second = NSTextView(frame: NSRect(x: 160, y: 0, width: 150, height: 180))
    window.contentView?.addSubview(first)
    window.contentView?.addSubview(second)
    window.makeFirstResponder(first)
    first.setMarkedText("测试", selectedRange: NSRange(location: 2, length: 0),
      replacementRange: NSRange(location: NSNotFound, length: 0))
    XCTAssertTrue(first.hasMarkedText())
    XCTAssertEqual(InputPolicy.waitResult(elapsed: 8, blocked: first.hasMarkedText(), cancelled: false), "userActive")
    UserActivity.note(.keyDown, pid: getpid(), code: 90)
    window.makeFirstResponder(second)
    first.unmarkText()
    XCTAssertFalse(first.hasMarkedText())
    XCTAssertFalse(second.hasMarkedText())
    // 用真实 HID 查询验证事件残留会清除；不投递任何系统输入、不读取别的应用。
    let deadline = Date().addingTimeInterval(InputPolicy.waitSeconds)
    while UserActivity.hasHeldInput && Date() < deadline { Thread.sleep(forTimeInterval: 0.05) }
    XCTAssertFalse(UserActivity.hasHeldInput, "硬件释放后不能保留未收到 keyUp 的按住状态")
    XCTAssertFalse(window.isVisible)
    // 只轮询硬件，不投递释放、不切换系统输入法、不抢全局焦点。
  }

  func testExplicitStopRemainsInSameTurnAndNewTurnRecovers() throws {
    var fds: [Int32] = [-1, -1]
    XCTAssertEqual(socketpair(AF_UNIX, SOCK_STREAM, 0, &fds), 0)
    let server = Server(socketPath: "/unused") { _ in fatalError("不启动监听") }
    let connection = Connection(id: 1, fd: fds[0], server: server)
    connection.authenticated = true
    let engine = Engine(connection: connection, mode: .closed, ownTeam: nil)
    defer { connection.shutdown(); close(fds[1]) }
    try engine.checkTurn(session: "fixture", turn: "one", key: "test", name: "Fixture")
    engine.userStopped(session: "fixture", appKey: "test", name: "Fixture")
    XCTAssertThrowsError(try engine.checkTurn(session: "fixture", turn: "one", key: "test", name: "Fixture")) { error in
      XCTAssertEqual((error as? RPCError)?.kind, .stopped)
      XCTAssertTrue((error as? RPCError)?.message.contains("new message") == true)
    }
    try engine.checkTurn(session: "fixture", turn: "two", key: "test", name: "Fixture")
    _ = try engine.handle(method: "turnEnded", params: ["session": "fixture", "turnId": "one"])
    try engine.checkTurn(session: "fixture", turn: "two", key: "test", name: "Fixture")
    XCTAssertThrowsError(try engine.checkTurn(session: "fixture", turn: "one", key: "test", name: "Fixture"))
  }
}
