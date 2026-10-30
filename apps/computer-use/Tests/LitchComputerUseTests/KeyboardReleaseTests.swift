import CoreGraphics
import XCTest
import LitchComputerUseCore
@testable import LitchComputerUse

final class KeyboardReleaseTests: XCTestCase {
  /// 投递到假窗口；模拟私有源记住最后一次事件的 flags，不触碰系统输入。
  final class Sink {
    var target: [CGEvent] = []
    var system: [CGEvent] = []
    var privateFlags: UInt64 = 0
    var globalFlags: UInt64 = 0
    var revision: UInt64 = 0
    var recover = true
    var io: Input.KeyboardIO {
      Input.KeyboardIO(target: { event, _ in
        self.target.append(event.copy()!)
        self.privateFlags = event.flags.rawValue
      }, system: { event in
        self.system.append(event.copy()!)
        if self.recover { self.globalFlags = event.flags.rawValue }
      }, flags: { self.globalFlags }, revision: { self.revision }, pause: {})
    }
  }

  func testConsecutiveCommandShortcutsReleaseBeforeForegroundRestoration() throws {
    let sink = Sink()
    for key in ["cmd+b", "cmd+s"] {
      // 前一条留下 Command 时这里会失败；不靠降低 2 秒/8 秒的让行门槛放过。
      XCTAssertEqual(InputPolicy.waitResult(elapsed: 0,
        idle: sink.globalFlags & Keys.command == 0 ? 3 : 0, cancelled: false), "ready")
      XCTAssertFalse(try Input.key(Keys.parse(key), pid: 1, io: sink.io))
      XCTAssertEqual(sink.privateFlags & Keys.command, 0)
      let restore = try XCTUnwrap(Input.pointerMove(to: .zero))
      XCTAssertEqual(restore.flags.intersection([.maskCommand, .maskShift, .maskAlternate, .maskControl]).rawValue, 0)
      sink.globalFlags = restore.flags.rawValue
    }
    XCTAssertEqual(sink.target.filter { $0.type == .keyDown }.count, 2)
    XCTAssertEqual(sink.target.filter { $0.type == .keyUp }.count, 2)
    XCTAssertTrue(sink.target.filter { $0.type != .keyDown }.allSatisfy { $0.flags.rawValue == 0 })
    XCTAssertTrue(sink.target.allSatisfy { $0.getIntegerValueField(.eventSourceUserData) == Input.marker })
  }

  func testCancellationAfterKeyDownStillReleasesKeyAndModifiers() throws {
    let sink = Sink()
    var checks = 0
    XCTAssertThrowsError(try Input.key(Keys.parse("cmd+shift+s"), pid: 1, check: {
      checks += 1
      if checks == 2 { throw RPCError(.stopped, "cancelled") }
    }, io: sink.io)) { error in
      XCTAssertEqual((error as? RPCError)?.kind, .stopped)
      XCTAssertTrue((error as? RPCError)?.message.contains("released") == true)
    }
    XCTAssertEqual(sink.target.filter { $0.type == .keyUp }.count, 1)
    XCTAssertEqual(sink.target.filter { $0.type == .flagsChanged }.count, 2)
    XCTAssertEqual(sink.privateFlags, 0)
  }

  func testAlreadyCancelledDoesNotInjectOrReleaseAnything() throws {
    let sink = Sink()
    XCTAssertThrowsError(try Input.key(Keys.parse("cmd+s"), pid: 1,
      check: { throw RPCError(.stopped, "before input") }, io: sink.io))
    XCTAssertTrue(sink.target.isEmpty && sink.system.isEmpty)
  }

  func testResidualModifierGetsOneSystemRecoveryAndReportsIt() throws {
    let sink = Sink()
    var checks = 0
    let repaired = try Input.key(Keys.parse("cmd+b"), pid: 1, check: {
      checks += 1
      if checks == 2 { sink.globalFlags = Keys.command }
    }, io: sink.io)
    XCTAssertTrue(repaired)
    XCTAssertEqual(sink.system.count, 1)
    XCTAssertEqual(sink.globalFlags, 0)
    XCTAssertEqual(sink.system[0].getIntegerValueField(.eventSourceUserData), Input.marker)
  }

  func testRecoveryFailureStopsInsteadOfSendingTheNextShortcut() throws {
    let sink = Sink()
    sink.recover = false
    var checks = 0
    XCTAssertThrowsError(try Input.key(Keys.parse("cmd+b"), pid: 1, check: {
      checks += 1
      if checks == 2 { sink.globalFlags = Keys.command }
    }, io: sink.io)) { error in
      XCTAssertEqual((error as? RPCError)?.kind, .failed)
      XCTAssertTrue((error as? RPCError)?.message.contains("Stop and ask") == true)
    }
    XCTAssertEqual(sink.system.count, 1)
  }

  func testCancelledShortcutAlsoRecoversResidueAndReportsOriginalFailure() throws {
    let sink = Sink()
    var checks = 0
    XCTAssertThrowsError(try Input.key(Keys.parse("cmd+s"), pid: 1, check: {
      checks += 1
      if checks == 2 { sink.globalFlags = Keys.command; throw RPCError(.stopped, "timeout") }
    }, io: sink.io)) { error in
      XCTAssertEqual((error as? RPCError)?.kind, .stopped)
      XCTAssertTrue((error as? RPCError)?.message.contains("Residual modifier keys were detected and released") == true)
    }
    XCTAssertEqual(sink.system.count, 1)
    XCTAssertEqual(sink.globalFlags, 0)
  }

  func testRealUserInterventionIsNotReleasedGloballyOrIgnored() throws {
    let sink = Sink()
    var checks = 0
    XCTAssertThrowsError(try Input.key(Keys.parse("cmd+b"), pid: 1, check: {
      checks += 1
      if checks == 2 { sink.revision += 1; sink.globalFlags = Keys.command }
    }, io: sink.io)) { error in
      XCTAssertEqual((error as? RPCError)?.kind, .userActive)
    }
    XCTAssertTrue(sink.system.isEmpty)
    XCTAssertEqual(sink.globalFlags, Keys.command)
    XCTAssertEqual(sink.privateFlags, 0)
  }

  func testPreviouslyHeldUserModifierIsNotTreatedAsOwnResidue() throws {
    let sink = Sink()
    sink.globalFlags = Keys.shift
    XCTAssertFalse(try Input.key(Keys.parse("shift+Right"), pid: 1, io: sink.io))
    XCTAssertTrue(sink.system.isEmpty)
    XCTAssertEqual(sink.globalFlags, Keys.shift)
  }

  func testShortcutOpeningAnotherWindowStillReleasesWithoutFalseStaleFailure() throws {
    let sink = Sink()
    var windowChecks = 0, cancellationChecks = 0
    XCTAssertFalse(try Input.key(Keys.parse("cmd+s"), pid: 1, check: {
      windowChecks += 1
      if windowChecks > 1 { throw RPCError(.stale, "save sheet replaced the old window") }
    }, checkAfterDown: {
      cancellationChecks += 1
    }, io: sink.io))
    XCTAssertEqual(windowChecks, 1)
    XCTAssertEqual(cancellationChecks, 1)
    XCTAssertEqual(sink.privateFlags, 0)
  }
}
