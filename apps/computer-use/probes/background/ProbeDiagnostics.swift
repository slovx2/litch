// 授权归属审计：只读，不访问或修改 TCC 数据库。记录实际检查权限的应用自身身份。
import AppKit
import ApplicationServices
import Darwin
import Foundation
import Security

enum ProbeDiagnostics {
  typealias Responsible = @convention(c) (pid_t) -> pid_t
  static let instanceID = UUID().uuidString
  static let startedAt = Date().timeIntervalSince1970

  static func executable(_ pid: pid_t) -> String? {
    var buffer = [CChar](repeating: 0, count: 4 * Int(MAXPATHLEN))
    guard proc_pidpath(pid, &buffer, UInt32(buffer.count)) > 0 else { return nil }
    return String(cString: buffer)
  }

  static func signing() -> [String: Any] {
    var code: SecCode?
    guard SecCodeCopySelf([], &code) == errSecSuccess, let code else { return [:] }
    var staticCode: SecStaticCode?
    guard SecCodeCopyStaticCode(code, [], &staticCode) == errSecSuccess, let staticCode else { return [:] }
    var value: CFDictionary?
    guard SecCodeCopySigningInformation(staticCode, SecCSFlags(rawValue: kSecCSSigningInformation), &value) == errSecSuccess,
      let info = value as? [String: Any] else { return [:] }
    return ["identifier": info[kSecCodeInfoIdentifier as String] ?? NSNull(),
      "teamId": info[kSecCodeInfoTeamIdentifier as String] ?? NSNull(),
      "valid": SecCodeCheckValidity(code, [], nil) == errSecSuccess]
  }

  static let identity: [String: Any] = {
    let pid = getpid()
    let quarantine = dlopen("/usr/lib/system/libquarantine.dylib", RTLD_NOW)
    let function = dlsym(quarantine, "responsibility_get_pid_responsible_for_pid")
    let responsible = function.map { unsafeBitCast($0, to: Responsible.self)(pid) }
    return ["pid": pid, "ppid": getppid(), "instanceID": instanceID, "startedAt": startedAt,
      "bundleId": Bundle.main.bundleIdentifier ?? "", "bundlePath": Bundle.main.bundlePath,
      "homeEnvironment": ProcessInfo.processInfo.environment["HOME"] ?? "",
      "codexHomeEnvironment": ProcessInfo.processInfo.environment["CODEX_HOME"] ?? "",
      "executable": executable(pid) ?? "", "signing": signing(),
      "responsiblePid": responsible.map { $0 as Any } ?? NSNull(),
      "responsiblePath": responsible.flatMap(executable) ?? "",
      "responsibleIsSelf": responsible.map { $0 == pid } as Any? ?? NSNull()]
  }()

  static func collect() -> [String: Any] {
    var result = identity
    result["sampledAt"] = Date().timeIntervalSince1970
    result["accessibility"] = AXIsProcessTrusted()
    result["eventPost"] = CGPreflightPostEventAccess()
    result["eventListen"] = CGPreflightListenEventAccess()
    result["frontPid"] = NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0
    result["keyboardIdleSeconds"] = CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: .keyDown)
    result["mouseIdleSeconds"] = CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: .mouseMoved)
    result["clickIdleSeconds"] = CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: .leftMouseDown)
    return result
  }
}
