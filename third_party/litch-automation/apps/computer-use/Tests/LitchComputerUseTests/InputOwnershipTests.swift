import Foundation
import XCTest
import LitchComputerUseCore
@testable import LitchComputerUse

final class InputOwnershipTests: XCTestCase {
  func testReleaseHandsOffImmediatelyWithoutEndingTurn() throws {
    let lane = InputOwnership()
    let first = try lane.acquire(pid: 1, owner: "a|", title: "商店草稿")
    lane.release(first)
    XCTAssertThrowsError(try lane.acquire(pid: 1, owner: "b|", title: "登录复测")) { error in
      XCTAssertTrue((error as? RPCError)?.message.contains("商店草稿") == true)
      XCTAssertTrue((error as? RPCError)?.message.contains("release") == true)
    }
    lane.end(prefix: "a|")
    let second = try lane.acquire(pid: 1, owner: "b|", title: "登录复测")
    XCTAssertTrue(lane.valid(pid: 1, owner: "b|", token: second))
    lane.release(second)
  }

  func testIdleOwnerExpiresButActiveInputNeverDoes() throws {
    var time = Date(timeIntervalSince1970: 0)
    let lane = InputOwnership(idleSeconds: 60, now: { time })
    let first = try lane.acquire(pid: 1, owner: "a|")
    time.addTimeInterval(600)
    XCTAssertThrowsError(try lane.acquire(pid: 1, owner: "b|"))
    lane.release(first)
    time.addTimeInterval(59)
    XCTAssertThrowsError(try lane.acquire(pid: 1, owner: "b|"))
    time.addTimeInterval(1)
    let second = try lane.acquire(pid: 1, owner: "b|")
    lane.release(second)
  }

  func testEndRevokesActionButKeepsLaneUntilCleanup() throws {
    let lane = InputOwnership()
    let first = try lane.acquire(pid: 1, owner: "a|")
    lane.end(prefix: "a|")
    XCTAssertFalse(lane.valid(pid: 1, owner: "a|", token: first))
    XCTAssertThrowsError(try lane.acquire(pid: 2, owner: "b|"))
    lane.release(first)
    let second = try lane.acquire(pid: 1, owner: "b|")
    lane.release(first)
    XCTAssertTrue(lane.valid(pid: 1, owner: "b|", token: second))
    lane.release(second)
  }

  func testEndingOneSessionDoesNotReleaseAnother() throws {
    let lane = InputOwnership()
    let first = try lane.acquire(pid: 1, owner: "a|")
    lane.release(first)
    lane.end(prefix: "b|")
    XCTAssertThrowsError(try lane.acquire(pid: 1, owner: "b|"))
    lane.end(prefix: "a|")
    let second = try lane.acquire(pid: 1, owner: "b|")
    lane.release(second)
  }
}
