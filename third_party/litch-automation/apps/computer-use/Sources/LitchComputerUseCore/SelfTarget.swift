// 只保护正式版。开发版、其他渠道和隔离验收进程不属于自身访问限制。
public enum SelfTarget {
  public static func matches(bundleId: String?, isolated: Bool, protectedIds: Set<String> = ["io.github.slovx2.litch"]) -> Bool {
    bundleId.map { protectedIds.contains($0) } == true && !isolated
  }

  /// KERN_PROCARGS2 的头是 argc，之后为可执行路径、参数和环境。只检查隔离标识，不返回环境内容。
  public static func isolated(arguments: [UInt8], environmentKeys: [String] = ["LITCH_PROFILE", "LITCH_MOCK"]) -> Bool {
    guard arguments.count >= 4 else { return false }
    let argc = arguments.prefix(4).enumerated().reduce(0) { $0 | Int($1.element) << ($1.offset * 8) }
    guard argc > 0, argc < 100_000 else { return false }
    var offset = 4
    while offset < arguments.count && arguments[offset] != 0 { offset += 1 }
    while offset < arguments.count && arguments[offset] == 0 { offset += 1 }
    for _ in 0..<argc {
      while offset < arguments.count && arguments[offset] != 0 { offset += 1 }
      offset += 1
    }
    guard offset < arguments.count else { return false }
    return arguments[offset...].split(separator: 0).contains { part in
      let entry = String(decoding: part, as: UTF8.self)
      return environmentKeys.map { "\($0)=" }.contains { entry.hasPrefix($0) && entry.count > $0.count }
    }
  }
}
