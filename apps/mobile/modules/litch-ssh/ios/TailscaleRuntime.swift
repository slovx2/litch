import Foundation
import Network
import Sshtransport

final class TailscaleRuntime {
  static let shared = TailscaleRuntime()
  private let lock = NSLock()
  private let storage = TailscaleStorage()
  private var initialized = false
  private let network = TailscalePathMonitor { SshtransportTailscaleNetworkChanged($0, $1) }

  func prepare() throws {
    lock.lock()
    defer { lock.unlock() }
    let files = FileManager.default
    network.start()
    var root = try files.url(for: .applicationSupportDirectory, in: .userDomainMask,
                             appropriateFor: nil, create: true).appendingPathComponent("LitchEmbeddedNetwork")
    // Clear 会删除 node；保留父目录的保护与排除备份属性，新建文件继续继承保护。
    try files.createDirectory(at: root, withIntermediateDirectories: true,
                              attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication])
    var values = URLResourceValues()
    values.isExcludedFromBackup = true
    try root.setResourceValues(values)
    guard !initialized else { return }
    let defaults = UserDefaults.standard
    let nameKey = "litch.tailscale.hostname"
    let hostname = defaults.string(forKey: nameKey) ?? "litch-ios-" + UUID().uuidString.prefix(8).lowercased()
    defaults.set(hostname, forKey: nameKey)
    // Go 在读取损坏状态之前已记下 storage，仍须允许后续 Clear 恢复。
    initialized = true
    try goVoid { SshtransportTailscaleInitialize(root.appendingPathComponent("node").path, hostname, storage, $0) }
  }

  func status() throws -> String {
    try prepare()
    return try goString { SshtransportTailscaleStatus($0) }
  }

  func stopNetworkMonitor() { network.stop() }
}

// NWPath 可在接口地址不变时变化；每次系统通知都重绑，旧 monitor 的迟到事件不生效。
final class TailscalePathMonitor {
  private let lock = NSLock()
  private let queue = DispatchQueue(label: "dev.litch.tailscale-network")
  private let notify: (String, Bool) -> Void
  private var monitor: NWPathMonitor?
  private var generation = UUID()
  private var revision = 0

  init(notify: @escaping (String, Bool) -> Void) { self.notify = notify }

  func start() {
    lock.lock()
    defer { lock.unlock() }
    guard monitor == nil else { return }
    let next = NWPathMonitor()
    let token = UUID()
    generation = token
    monitor = next
    next.pathUpdateHandler = { [weak self] path in self?.changed(token, available: path.status == .satisfied) }
    next.start(queue: queue)
  }

  private func changed(_ token: UUID, available: Bool) {
    lock.lock()
    defer { lock.unlock() }
    guard monitor != nil, generation == token else { return }
    revision += 1
    notify("ios-\(token)-\(revision)", available)
  }

  func stop() {
    lock.lock()
    defer { lock.unlock() }
    generation = UUID()
    monitor?.cancel()
    monitor = nil
  }
}

func goVoid(_ call: (AutoreleasingUnsafeMutablePointer<NSError?>) -> Bool) throws {
  var error: NSError?
  _ = call(&error)
  if let error { throw error }
}

// C 函数不会自动桥接成 throws；不能把 Go 的失败误当成空字符串。
func goString(_ call: (AutoreleasingUnsafeMutablePointer<NSError?>) -> String) throws -> String {
  var error: NSError?
  let result = call(&error)
  if let error { throw error }
  return result
}
