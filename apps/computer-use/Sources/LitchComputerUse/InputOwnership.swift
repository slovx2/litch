// 全助手串行投递；应用租约支持主动交还，空闲后回收，但执行中的输入绝不抢占。
import Foundation
import LitchComputerUseCore

final class InputOwnership {
  static let shared = InputOwnership()
  private let lock = NSLock()
  private struct Owner {
    let key: String
    let title: String
    var touched: Date
  }
  private var owners: [pid_t: Owner] = [:]
  private var active: (token: UUID, pid: pid_t, owner: Owner)?
  private let now: () -> Date
  private let idleSeconds: TimeInterval

  init(idleSeconds: TimeInterval = 60, now: @escaping () -> Date = Date.init) {
    self.idleSeconds = idleSeconds
    self.now = now
  }

  func acquire(pid: pid_t, owner: String, title: String = "") throws -> UUID {
    lock.lock(); defer { lock.unlock() }
    let time = now()
    owners = owners.filter { $0.key == active?.pid || time.timeIntervalSince($0.value.touched) < idleSeconds }
    if let conflict = active?.owner ?? owners[pid].flatMap({ $0.key == owner ? nil : $0 }) {
      throw RPCError(.userActive,
        "Computer Use is owned by session \"\(conflict.title)\". Ask that session to release its Chrome tabs or finish/stop its turn. Idle app ownership expires after \(Int(idleSeconds)) seconds; an active action must finish first.")
    }
    let record = Owner(key: owner, title: title.isEmpty ? owner : title, touched: time)
    owners[pid] = record
    let token = UUID()
    active = (token, pid, record)
    return token
  }

  func valid(pid: pid_t, owner: String, token: UUID) -> Bool {
    lock.lock(); defer { lock.unlock() }
    return owners[pid]?.key == owner && active?.token == token
  }

  func release(_ token: UUID) {
    lock.lock(); defer { lock.unlock() }
    if let current = active, current.token == token {
      if owners[current.pid]?.key == current.owner.key { owners[current.pid]?.touched = now() }
      active = nil
    }
  }
  func waitUntilIdle(prefix: String? = nil) throws {
    let deadline = Date().addingTimeInterval(2)
    while lock.withLock({ active.map { prefix == nil || $0.owner.key.hasPrefix(prefix!) } ?? false }) {
      if Date() >= deadline { throw RPCError(.userActive, "The previous input is still being released. Try taking over again.") }
      Thread.sleep(forTimeInterval: 0.01)
    }
  }
  func end(prefix: String) {
    lock.lock(); owners = owners.filter { !$0.value.key.hasPrefix(prefix) }; lock.unlock()
  }
}
