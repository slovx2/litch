// 全助手串行投递；应用租约持续到回合结束、接管或连接关闭。
import Foundation
import LitchComputerUseCore

final class InputOwnership {
  static let shared = InputOwnership()
  private let lock = NSLock()
  private var owners: [pid_t: String] = [:]
  private var active: UUID?

  func acquire(pid: pid_t, owner: String) throws -> UUID {
    lock.lock(); defer { lock.unlock() }
    guard active == nil, owners[pid] == nil || owners[pid] == owner else {
      throw RPCError(.userActive, "Another Computer Use action owns this app or the input lane. Retry after it finishes.")
    }
    owners[pid] = owner
    let token = UUID()
    active = token
    return token
  }

  func valid(pid: pid_t, owner: String, token: UUID) -> Bool {
    lock.lock(); defer { lock.unlock() }
    return owners[pid] == owner && active == token
  }

  func release(_ token: UUID) { lock.lock(); if active == token { active = nil }; lock.unlock() }
  func waitUntilIdle() throws {
    let deadline = Date().addingTimeInterval(2)
    while lock.withLock({ active != nil }) {
      if Date() >= deadline { throw RPCError(.userActive, "The previous input is still being released. Try taking over again.") }
      Thread.sleep(forTimeInterval: 0.01)
    }
  }
  func end(prefix: String) {
    lock.lock(); owners = owners.filter { !$0.value.hasPrefix(prefix) }; lock.unlock()
  }
}
