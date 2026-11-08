import Darwin
import Foundation
import XCTest
@testable import LitchComputerUseCore

final class SocketWriterTests: XCTestCase {
  private func pair() throws -> [Int32] {
    var fds: [Int32] = [-1, -1]
    guard socketpair(AF_UNIX, SOCK_STREAM, 0, &fds) == 0 else { throw POSIXError(.EIO) }
    var on: Int32 = 1
    setsockopt(fds[0], SOL_SOCKET, SO_NOSIGPIPE, &on, socklen_t(MemoryLayout<Int32>.size))
    return fds
  }

  func testWholeFrameAndClosedReceiver() throws {
    let fds = try pair()
    defer { close(fds[0]) }
    let payload = Data("一帧测试".utf8)
    guard SocketWriter.write(payload, to: fds[0]) else {
      XCTFail("完整帧写入失败"); close(fds[1]); return
    }
    var buffer = [UInt8](repeating: 0, count: 64)
    let count = read(fds[1], &buffer, buffer.count)
    XCTAssertEqual(Data(buffer.prefix(max(0, count))), payload)
    close(fds[1])
    XCTAssertFalse(SocketWriter.write(payload, to: fds[0]))
  }

  func testReceiverNotReadingTimesOutWithoutChangingReadMode() throws {
    let fds = try pair()
    defer { close(fds[0]); close(fds[1]) }
    var size: Int32 = 4096
    setsockopt(fds[0], SOL_SOCKET, SO_SNDBUF, &size, socklen_t(MemoryLayout<Int32>.size))
    let before = fcntl(fds[0], F_GETFL)
    let start = ProcessInfo.processInfo.systemUptime
    XCTAssertFalse(SocketWriter.write(Data(repeating: 1, count: 1024 * 1024), to: fds[0], timeout: 0.1))
    let elapsed = ProcessInfo.processInfo.systemUptime - start
    XCTAssertGreaterThanOrEqual(elapsed, 0.08)
    XCTAssertLessThan(elapsed, 1)
    XCTAssertEqual(fcntl(fds[0], F_GETFL), before)
  }
}
