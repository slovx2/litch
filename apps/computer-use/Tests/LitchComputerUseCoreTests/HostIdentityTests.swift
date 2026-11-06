import Foundation
import XCTest
@testable import LitchComputerUseCore

final class HostIdentityTests: XCTestCase {
  let config = #"{"productName":"Second Host","helperName":"Second Helper","helperId":"ai.example.helper","allowedPeerIds":["ai.example.host"],"protectedTargetIds":["ai.example.host"],"isolationEnvironmentKeys":["SECOND_PROFILE"],"directoryEnvironmentKey":"SECOND_CU_DIR","tokenEnvironmentKey":"SECOND_CU_TOKEN","defaultStateSubdirectory":"Library/Application Support/Second/computer-use"}"#

  func testIndependentSignedIdentity() throws {
    let identity = try HostIdentity.decode(config)
    let peer = PeerAuth.Peer(uid: 501, teamId: "T", identifier: "ai.example.host", signatureValid: true)
    XCTAssertNil(PeerAuth.check(mode: .team("T"), ownUid: 501, peer: peer, offeredToken: nil, allowedIdentifiers: Set(identity.allowedPeerIds), productName: identity.productName))
    XCTAssertNotNil(PeerAuth.check(mode: .team("T"), ownUid: 501, peer: peer, offeredToken: nil))
    let litch = PeerAuth.Peer(uid: 501, teamId: "T", identifier: "io.github.slovx2.litch", signatureValid: true)
    XCTAssertNotNil(PeerAuth.check(mode: .team("T"), ownUid: 501, peer: litch, offeredToken: String(repeating: "a", count: 64), allowedIdentifiers: Set(identity.allowedPeerIds)))
    XCTAssertTrue(SelfTarget.matches(bundleId: "ai.example.host", isolated: false, protectedIds: Set(identity.protectedTargetIds)))
    XCTAssertFalse(SelfTarget.matches(bundleId: "io.github.slovx2.litch", isolated: false, protectedIds: Set(identity.protectedTargetIds)))
    XCTAssertEqual(Copy.banner(.en, app: "fixture", productName: identity.productName), "Second Host is controlling fixture")
  }

  func testInvalidIdentityFailsClosed() {
    XCTAssertThrowsError(try HostIdentity.decode("{}"))
    XCTAssertThrowsError(try HostIdentity.decode(config.replacingOccurrences(of: "[\"ai.example.host\"]", with: "[]")))
    XCTAssertThrowsError(try HostIdentity.decode(config.replacingOccurrences(of: "Library/Application Support/Second/computer-use", with: "../other")))
  }

  func testSharedGoldenFrames() throws {
    let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
    let path = root.appendingPathComponent("../../../../packages/computer-use/test/native-frames.json").standardized
    let cases = try JSONSerialization.jsonObject(with: Data(contentsOf: path)) as! [[String: Any]]
    for fixture in cases {
      let hex = fixture["hex"] as! String
      var bytes = Data()
      var offset = hex.startIndex
      while offset < hex.endIndex {
        let end = hex.index(offset, offsetBy: 2)
        bytes.append(UInt8(hex[offset..<end], radix: 16)!)
        offset = end
      }
      var reader = FrameReader()
      for byte in bytes { reader.append(Data([byte])) }
      let decoded = try XCTUnwrap(reader.next())
      let expected = try JSONDecoder().decode(JSONValue.self, from: JSONSerialization.data(withJSONObject: fixture["value"]!))
      XCTAssertEqual(decoded, expected)
      XCTAssertNil(try reader.next())
      reader.append(try Wire.frame(expected))
      XCTAssertEqual(try reader.next(), expected)
    }
  }
}
