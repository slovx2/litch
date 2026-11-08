import XCTest

@testable import LitchComputerUseCore

final class WireTests: XCTestCase {
  func testFrameRoundTrip() throws {
    let value: JSONValue = [
      "jsonrpc": "2.0", "id": 7, "method": "hello",
      "params": ["protocol": 1, "token": "abc", "nested": [1, 2.5, true, nil, "中文"]],
    ]
    let frame = try Wire.frame(value)
    // 前 4 字节是大端的长度
    let length = Int(frame[0]) << 24 | Int(frame[1]) << 16 | Int(frame[2]) << 8 | Int(frame[3])
    XCTAssertEqual(length, frame.count - 4)
    var reader = FrameReader()
    reader.append(frame)
    XCTAssertEqual(try reader.next(), value)
    XCTAssertNil(try reader.next())
  }

  func testSplitAndConcatenatedFrames() throws {
    let first = try Wire.frame(["a": 1])
    let second = try Wire.frame(["b": "两帧"])
    var joined = first
    joined.append(second)
    var reader = FrameReader()
    // 一个字节一个字节地喂
    var got: [JSONValue] = []
    for byte in joined {
      reader.append(Data([byte]))
      while let frame = try reader.next() { got.append(frame) }
    }
    XCTAssertEqual(got, [["a": 1], ["b": "两帧"]])
  }

  func testRejectsOversizedLength() {
    var reader = FrameReader()
    reader.append(Data([0xFF, 0xFF, 0xFF, 0xFF]))
    XCTAssertThrowsError(try reader.next()) { error in
      XCTAssertEqual(error as? WireError, .frameTooLarge(0xFFFF_FFFF))
    }
  }

  func testRejectsBadJSON() {
    var reader = FrameReader()
    let body = Data("{nope".utf8)
    var length = UInt32(body.count).bigEndian
    var data = Data(bytes: &length, count: 4)
    data.append(body)
    reader.append(data)
    XCTAssertThrowsError(try reader.next())
  }

  func testIntegersStayIntegers() throws {
    let frame = try Wire.frame(["n": 3, "x": 1.5])
    let text = String(data: frame.dropFirst(4), encoding: .utf8)!
    XCTAssertTrue(text.contains("\"n\":3"), text)
    XCTAssertTrue(text.contains("\"x\":1.5"), text)
  }

  func testParseMessages() {
    XCTAssertEqual(
      RPCMessage.parse(["jsonrpc": "2.0", "id": 1, "method": "listApps"]),
      .request(id: 1, method: "listApps", params: [:]))
    XCTAssertEqual(
      RPCMessage.parse(["jsonrpc": "2.0", "method": "ping", "params": ["a": 1]]),
      .notification(method: "ping", params: ["a": 1]))
    XCTAssertNil(RPCMessage.parse(["jsonrpc": "2.0", "id": 1, "result": [:]]))
  }

  func testErrorShape() {
    let error = RPC.error(id: 3, RPCError(.permission, "Accessibility"))
    XCTAssertEqual(error["error"]?["data"]?["kind"], "permission")
    XCTAssertEqual(error["error"]?["message"], "Accessibility")
    XCTAssertEqual(RPCError(.invalid, "x").code, -32602)
  }
}
