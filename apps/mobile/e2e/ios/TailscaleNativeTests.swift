import XCTest
import Security
import Sshtransport

// 独立 ad-hoc 签名的 iOS 测试宿主，编入原样的生产 Keychain/生命周期代码与 XCFramework。
// 配置、SSH 私钥与 CA 都只来自隔离夹具，测试结果不输出任何钥匙或完整状态。
final class TailscaleNativeTests: XCTestCase {
  func testNetworkPathMonitorCanStopAndRestart() {
    let first = expectation(description: "首次收到系统路径")
    let second = expectation(description: "重启后收到系统路径")
    let stale = expectation(description: "停止后不再通知")
    stale.isInverted = true
    let lock = NSLock()
    var phase = 0
    var tokens: [String] = []
    let monitor = TailscalePathMonitor { token, _ in
      lock.lock()
      defer { lock.unlock() }
      switch phase {
      case 0: tokens.append(token); phase = 1; first.fulfill()
      case 2: stale.fulfill()
      case 3: tokens.append(token); phase = 4; second.fulfill()
      default: break
      }
    }
    monitor.start()
    monitor.start()
    wait(for: [first], timeout: 5)
    monitor.stop()
    lock.lock(); phase = 2; lock.unlock()
    wait(for: [stale], timeout: 0.2)
    lock.lock(); phase = 3; lock.unlock()
    monitor.start()
    wait(for: [second], timeout: 5)
    monitor.stop()
    XCTAssertEqual(tokens.count, 2)
    XCTAssertNotEqual(tokens.first, tokens.last)
  }

  func testSecureNetwork() throws {
    let configURL = Bundle(for: Self.self).url(forResource: "validation", withExtension: "json")!
    let config = try JSONSerialization.jsonObject(with: Data(contentsOf: configURL)) as! [String: Any]
    var target = config["target"] as! [String: Any]
    target["host"] = "server.litch.test"
    target["port"] = 2222
    target["tailscale"] = "always"
    let control = config["controlURL"] as! String
    let store = TailscaleStorage()
    try store.clear()
    try store.write("{\"isolated\":true}")
    XCTAssertEqual(try TailscaleStorage().readState(), "{\"isolated\":true}")
    var attributes: CFTypeRef?
    let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: (Bundle.main.bundleIdentifier! + ".tailscale"),
      kSecAttrAccount as String: "node-state", kSecReturnAttributes as String: true]
    XCTAssertEqual(SecItemCopyMatching(query as CFDictionary, &attributes), errSecSuccess)
    let saved = attributes as! [String: Any]
    XCTAssertEqual(saved[kSecAttrAccessible as String] as? String, kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly as String)
    XCTAssertEqual(saved[kSecAttrSynchronizable as String] as? Bool, false)
    try store.clear()
    XCTAssertTrue(try store.readState().isEmpty)
    // 损坏状态不能静默换身份；清除后应能恢复。
    try store.write("{")
    XCTAssertThrowsError(try TailscaleRuntime.shared.prepare())
    XCTAssertThrowsError(try TailscaleRuntime.shared.status())
    try goVoid { SshtransportTailscaleClear($0) }
    XCTAssertEqual(try json(TailscaleRuntime.shared.status())["state"] as? String, "stopped")
    let support = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: false)
    let root = support.appendingPathComponent("LitchEmbeddedNetwork")
    XCTAssertEqual(try root.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup, true)
    // 模拟器不返回 NSFileProtectionKey；硬件锁屏下的数据保护另列真机验收，不能假通过。
    defer {
      try? goVoid { SshtransportTailscaleClear($0) }
      SshtransportSetAppBackground(false)
    }
    XCTAssertThrowsError(try goString { SshtransportTailscaleLogin("http://127.0.0.1", $0) })
    XCTAssertThrowsError(try goString { SshtransportProbeHost("server", 2222, "test", "always", $0) })
    _ = try goString { SshtransportTailscaleLogin(control, $0) }
    try connected()
    let before = try store.readState()
    XCTAssertFalse(before.isEmpty)
    // MagicDNS 短名与完整域名均需经相同 SSH 指纹校验。
    for host in ["server", "server.litch.test"] {
      let probe = try json(goString { SshtransportProbeHost(host, 2222, target["user"] as! String, "always", $0) })
      XCTAssertEqual(probe["fingerprint"] as? String, target["hostFingerprint"] as? String)
    }
    try run(target)
    var wrong = target
    wrong["hostFingerprint"] = "SHA256:wrong"
    assertFailure(wrong, contains: "[hostKeyChanged]")
    let generated = try json(goString { SshtransportGenerateEd25519Key($0) })
    wrong = target
    wrong["privateKey"] = generated["privateKey"]
    assertFailure(wrong, contains: "[auth]")
    // 无 VPN、公网回退：非 tailnet 目标必须拒绝。
    XCTAssertThrowsError(try goString { SshtransportProbeHost("127.0.0.1", 2222, "test", "always", $0) })
    let scheduler = DeadlineCapture()
    SshtransportSetBackgroundScheduler(scheduler)
    defer { SshtransportSetBackgroundScheduler(nil) }
    SshtransportSetBackgroundTimeout(1)
    SshtransportSetAppBackground(true)
    SshtransportBackgroundDeadline(scheduler.epoch)
    XCTAssertEqual(try json(TailscaleRuntime.shared.status())["state"] as? String, "suspended")
    SshtransportSetAppBackground(false)
    try connected()
    try run(target)
    XCTAssertTrue(try store.readState() == before, "恢复后持久化身份改变")
    try goVoid { SshtransportTailscaleLogout($0) }
    XCTAssertThrowsError(try goString { SshtransportProbeHost("server", 2222, "test", "always", $0) })
    try goVoid { SshtransportTailscaleClear($0) }
    XCTAssertTrue(try store.readState().isEmpty)
    XCTAssertEqual(try json(TailscaleRuntime.shared.status())["state"] as? String, "stopped")
  }

  private func json(_ text: String) throws -> [String: Any] {
    try JSONSerialization.jsonObject(with: Data(text.utf8)) as! [String: Any]
  }

  private func encoded(_ target: [String: Any]) throws -> String {
    String(data: try JSONSerialization.data(withJSONObject: target), encoding: .utf8)!
  }

  private func run(_ target: [String: Any]) throws {
    let value = try encoded(target)
    let result = try json(goString { SshtransportRunScript(value, "printf 'LITCH_NATIVE_TEST\\nconnected\\n'", "LITCH_NATIVE_TEST", $0) })
    XCTAssertEqual(result["output"] as? String, "connected\n")
    XCTAssertEqual(result["code"] as? Int, 0)
  }

  private func assertFailure(_ target: [String: Any], contains message: String) {
    do {
      let value = try encoded(target)
      _ = try goString { SshtransportRunScript(value, "true", "", $0) }
      XCTFail("错误 SSH 凭据被接受")
    } catch {
      XCTAssertTrue(error.localizedDescription.contains(message), "错误类别不符：\(message)")
    }
  }

  private func connected() throws {
    for _ in 0..<150 {
      if try json(TailscaleRuntime.shared.status())["state"] as? String == "connected" { return }
      Thread.sleep(forTimeInterval: 0.2)
    }
    XCTFail("本地 tailnet 未连接")
    throw NSError(domain: "LitchTest", code: 1)
  }
}

private final class DeadlineCapture: NSObject, SshtransportBackgroundSchedulerProtocol {
  var epoch: Int64 = -1
  func nowMillis() -> Int64 { Int64(clock_gettime_nsec_np(CLOCK_MONOTONIC_RAW) / 1_000_000) }
  func schedule(_ deadlineMillis: Int64, epoch: Int64) { self.epoch = epoch }
  func cancel() {}
}
