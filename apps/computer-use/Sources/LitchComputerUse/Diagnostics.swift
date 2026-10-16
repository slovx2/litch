// 日志、自己的签名信息、责任进程。
//
// 责任进程：macOS 记辅助功能、屏幕录制授权时算在“责任进程”头上，不一定是真正调接口的那个进程。
// 被别的进程直接 fork/spawn 出来的子进程，责任进程沿用父进程的；经 LaunchServices（open、NSWorkspace）打开的应用
// 自己就是责任进程。系统没有公开的查询接口，这里经 dlsym 调 libquarantine 里的私有函数
// responsibility_get_pid_responsible_for_pid，只用来自检和报告，查不到就报 null，不影响功能。
import Darwin
import Foundation
import LitchComputerUseCore
import Security

enum Log {
  private static let lock = NSLock()
  private static var handle: FileHandle?

  /// 日志写到 <目录>/helper.log；超过 1 MB 时先清空
  static func open(directory: String) {
    let path = (directory as NSString).appendingPathComponent("helper.log")
    if let size = (try? FileManager.default.attributesOfItem(atPath: path))?[.size] as? Int,
      size > 1_000_000
    {
      try? FileManager.default.removeItem(atPath: path)
    }
    if !FileManager.default.fileExists(atPath: path) {
      FileManager.default.createFile(
        atPath: path, contents: nil, attributes: [.posixPermissions: 0o600])
    }
    handle = FileHandle(forWritingAtPath: path)
    handle?.seekToEndOfFile()
  }

  static func write(_ message: String) {
    lock.lock()
    defer { lock.unlock() }
    let line = "\(ISO8601DateFormatter().string(from: Date())) [\(getpid())] \(message)\n"
    if let handle {
      handle.write(Data(line.utf8))
    } else {
      FileHandle.standardError.write(Data(line.utf8))
    }
  }
}

enum Diagnostics {
  private typealias ResponsibleFn = @convention(c) (pid_t) -> pid_t

  /// 某个进程的责任进程号；查不到回 nil
  static func responsiblePid(of pid: pid_t) -> pid_t? {
    guard let handle = dlopen(nil, RTLD_NOW),
      let symbol = dlsym(handle, "responsibility_get_pid_responsible_for_pid")
    else { return nil }
    let function = unsafeBitCast(symbol, to: ResponsibleFn.self)
    let result = function(pid)
    return result > 0 ? result : nil
  }

  /// 进程的可执行文件路径
  static func path(of pid: pid_t) -> String? {
    var buffer = [CChar](repeating: 0, count: 4 * Int(MAXPATHLEN))
    let length = proc_pidpath(pid, &buffer, UInt32(buffer.count))
    return length > 0 ? String(cString: buffer) : nil
  }

  struct Signing {
    var teamId: String?
    var identifier: String?
    var adhoc: Bool
  }

  /// 自己的签名：团队号、签名标识、是不是临时签名
  static func ownSigning() -> Signing {
    var code: SecCode?
    guard SecCodeCopySelf([], &code) == errSecSuccess, let code else {
      return Signing(teamId: nil, identifier: nil, adhoc: true)
    }
    var staticCode: SecStaticCode?
    guard SecCodeCopyStaticCode(code, [], &staticCode) == errSecSuccess, let staticCode else {
      return Signing(teamId: nil, identifier: nil, adhoc: true)
    }
    var info: CFDictionary?
    SecCodeCopySigningInformation(
      staticCode, SecCSFlags(rawValue: kSecCSSigningInformation), &info)
    let dict = (info as? [String: Any]) ?? [:]
    let flags = (dict[kSecCodeInfoFlags as String] as? NSNumber)?.uint32Value ?? 0
    // kSecCodeSignatureAdhoc = 0x2
    return Signing(
      teamId: dict[kSecCodeInfoTeamIdentifier as String] as? String,
      identifier: dict[kSecCodeInfoIdentifier as String] as? String,
      adhoc: flags & 0x2 != 0 || dict[kSecCodeInfoTeamIdentifier as String] == nil)
  }

  /// 给主进程和自检看的一份：进程号、父进程、责任进程、签名
  static func collect() -> JSONValue {
    let pid = getpid()
    let responsible = responsiblePid(of: pid)
    let signing = ownSigning()
    return [
      "pid": .int(Int(pid)),
      "ppid": .int(Int(getppid())),
      "parentPath": .optional(path(of: getppid())),
      "responsiblePid": responsible.map { .int(Int($0)) } ?? .null,
      "responsiblePath": .optional(responsible.flatMap { path(of: $0) }),
      "responsibleIsSelf": responsible.map { .bool($0 == pid) } ?? .null,
      "executable": .optional(path(of: pid)),
      "bundleId": .optional(Bundle.main.bundleIdentifier),
      "bundlePath": .string(Bundle.main.bundlePath),
      "version": .optional(Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String),
      "signing": [
        "teamId": .optional(signing.teamId),
        "identifier": .optional(signing.identifier),
        "adhoc": .bool(signing.adhoc),
      ],
    ]
  }
}
