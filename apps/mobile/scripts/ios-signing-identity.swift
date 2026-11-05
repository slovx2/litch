// 本机首次签名准备：私钥直接生成在 Keychain，磁盘只写 CSR 和加密的 PKCS#12。
import Foundation
import Security

enum Failure: Error { case message(String) }
func check(_ status: OSStatus) throws {
  if status != errSecSuccess {
    throw Failure.message("Keychain 错误：\(status)")
  }
}
func der(_ tag: UInt8, _ bytes: Data) -> Data {
  var length = bytes.count
  var encoded: [UInt8] = []
  if length < 128 { encoded = [UInt8(length)] }
  else {
    while length > 0 { encoded.insert(UInt8(length & 255), at: 0); length >>= 8 }
    encoded.insert(0x80 | UInt8(encoded.count), at: 0)
  }
  return Data([tag] + encoded) + bytes
}
func seq(_ bytes: Data) -> Data { der(0x30, bytes) }
func algorithm(_ last: UInt8) -> Data {
  seq(der(0x06, Data([0x2a,0x86,0x48,0x86,0xf7,0x0d,0x01,0x01,last])) + Data([0x05,0]))
}
func createCSR(_ output: String) throws {
  let tag = Data("dev.litch.ios-distribution.20261105".utf8)
  var existing: CFTypeRef?
  let status = SecItemCopyMatching([
    kSecClass: kSecClassKey, kSecAttrApplicationTag: tag,
    kSecAttrKeyClass: kSecAttrKeyClassPrivate, kSecReturnRef: true,
  ] as CFDictionary, &existing)
  let key: SecKey
  if status == errSecSuccess { key = existing as! SecKey }
  else {
    guard status == errSecItemNotFound else { try check(status); return }
    var error: Unmanaged<CFError>?
    guard let created = SecKeyCreateRandomKey([
      kSecAttrKeyType: kSecAttrKeyTypeRSA, kSecAttrKeySizeInBits: 2048,
      kSecPrivateKeyAttrs: [kSecAttrIsPermanent: true, kSecAttrApplicationTag: tag,
        kSecAttrLabel: "Litch CI Distribution"],
    ] as CFDictionary, &error) else {
      throw Failure.message("无法在钥匙串生成签名私钥，请检查钥匙串是否已解锁")
    }
    key = created
  }
  var error: Unmanaged<CFError>?
  guard let publicKey = SecKeyCopyPublicKey(key),
        let publicData = SecKeyCopyExternalRepresentation(publicKey, &error) as Data? else {
    throw Failure.message("无法取得公钥")
  }
  let subject = seq(der(0x31, seq(der(0x06, Data([0x55,0x04,0x03]))
    + der(0x0c, Data("Litch CI Distribution".utf8)))))
  let publicInfo = seq(algorithm(1) + der(0x03, Data([0]) + publicData))
  let request = seq(Data([0x02,0x01,0]) + subject + publicInfo + Data([0xa0,0]))
  guard let signature = SecKeyCreateSignature(key, .rsaSignatureMessagePKCS1v15SHA256,
    request as CFData, &error) as Data? else {
    throw Failure.message("钥匙串拒绝签署 CSR；如系统提示解锁，请由用户处理")
  }
  let csr = seq(request + algorithm(11) + der(0x03, Data([0]) + signature))
  let base64 = csr.base64EncodedString(options: [.lineLength64Characters, .endLineWithLineFeed])
  try "-----BEGIN CERTIFICATE REQUEST-----\n\(base64)\n-----END CERTIFICATE REQUEST-----\n"
    .write(toFile: output, atomically: true, encoding: .utf8)
  print("CSR 已生成；私钥保留在本机钥匙串")
}
func exportIdentity(_ certificatePath: String, _ output: String) throws {
  let data = try Data(contentsOf: URL(fileURLWithPath: certificatePath))
  guard let certificate = SecCertificateCreateWithData(nil, data as CFData) else {
    throw Failure.message("无效的 Apple 证书")
  }
  let status = SecItemAdd([kSecClass: kSecClassCertificate, kSecValueRef: certificate] as CFDictionary, nil)
  if status != errSecDuplicateItem { try check(status) }
  var identity: SecIdentity?
  try check(SecIdentityCreateWithCertificate(nil, certificate, &identity))
  guard let identity else { throw Failure.message("证书无法匹配本机私钥") }
  let passwordData = FileHandle.standardInput.readDataToEndOfFile()
  guard let password = String(data: passwordData, encoding: .utf8), password.count >= 32 else {
    throw Failure.message("须经 stdin 提供随机 PKCS#12 密码")
  }
  var parameters = SecItemImportExportKeyParameters()
  parameters.version = UInt32(SEC_KEY_IMPORT_EXPORT_PARAMS_VERSION)
  let passphrase = password as CFString
  parameters.passphrase = Unmanaged.passUnretained(passphrase)
  var exported: CFData?
  try withExtendedLifetime(passphrase) {
    try check(SecItemExport(identity, .formatPKCS12, [], &parameters, &exported))
  }
  guard let exported else { throw Failure.message("未导出 PKCS#12") }
  try (exported as Data).write(to: URL(fileURLWithPath: output), options: [.atomic])
  try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: output)
  print("专用分发身份已导出为加密 PKCS#12；钥匙串私钥未删除")
}
do {
  let args = CommandLine.arguments
  if args.count == 3 && args[1] == "csr" { try createCSR(args[2]) }
  else if args.count == 4 && args[1] == "export" { try exportIdentity(args[2], args[3]) }
  else { throw Failure.message("用法：ios-signing-identity csr <CSR绝对路径> | export <CER绝对路径> <P12绝对路径>") }
} catch {
  // 不输出底层 Error 的 userInfo，避免系统 API 将输入参数带进日志。
  if case Failure.message(let message) = error { fputs("\(message)\n", stderr) }
  else { fputs("签名身份操作失败，请检查系统钥匙串提示和文件权限\n", stderr) }
  exit(1)
}
