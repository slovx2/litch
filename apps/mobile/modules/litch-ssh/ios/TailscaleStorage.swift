import Foundation
import Security
import Sshtransport

// 完整状态只在 Go 与 Keychain 间传递。ThisDeviceOnly 禁止备份迁移，也不参加 iCloud 同步。
final class TailscaleStorage: NSObject, SshtransportTailscaleStorageProtocol {
  private let lock = NSLock()
  private let service = (Bundle.main.bundleIdentifier ?? "dev.litch.app") + ".tailscale"

  private var query: [String: Any] {
    [kSecClass as String: kSecClassGenericPassword,
     kSecAttrService as String: service,
     kSecAttrAccount as String: "node-state",
     kSecAttrSynchronizable as String: false]
  }

  // gomobile 的非空 NSString 返回值保留 NSError 指针，Swift 不会自动导入为 throws。
  func read(_ error: NSErrorPointer) -> String {
    do { return try readState() }
    catch let failure { error?.pointee = failure as NSError; return "" }
  }

  func readState() throws -> String {
    lock.lock()
    defer { lock.unlock() }
    var request = query
    request[kSecReturnData as String] = true
    request[kSecMatchLimit as String] = kSecMatchLimitOne
    var result: CFTypeRef?
    let status = SecItemCopyMatching(request as CFDictionary, &result)
    if status == errSecItemNotFound { return "" }
    try check(status)
    guard let data = result as? Data, let state = String(data: data, encoding: .utf8) else {
      throw NSError(domain: "LitchTailscaleStorage", code: -1,
                    userInfo: [NSLocalizedDescriptionKey: "[tailscaleStorage] Invalid Keychain state"])
    }
    return state
  }

  func write(_ state: String?) throws {
    lock.lock()
    defer { lock.unlock() }
    guard let state else {
      throw NSError(domain: "LitchTailscaleStorage", code: -2,
                    userInfo: [NSLocalizedDescriptionKey: "[tailscaleStorage] Missing state"])
    }
    let attributes: [String: Any] = [
      kSecValueData as String: Data(state.utf8),
      kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
    ]
    let status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
    if status == errSecItemNotFound {
      try check(SecItemAdd(query.merging(attributes) { _, value in value } as CFDictionary, nil))
    } else {
      try check(status)
    }
  }

  func clear() throws {
    lock.lock()
    defer { lock.unlock() }
    let status = SecItemDelete(query as CFDictionary)
    if status != errSecItemNotFound { try check(status) }
  }

  private func check(_ status: OSStatus) throws {
    guard status != errSecSuccess else { return }
    // 只传错误类别和系统码，不把状态或钥匙写到日志与 JS。
    throw NSError(domain: "LitchTailscaleStorage", code: Int(status),
                  userInfo: [NSLocalizedDescriptionKey: "[tailscaleStorage] Keychain error (\(status))"])
  }
}
