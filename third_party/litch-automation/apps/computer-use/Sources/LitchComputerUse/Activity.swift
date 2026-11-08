// 正在被操作的应用的登记表（全进程一份）：屏幕提示按它显示，用户按停止时按它通知各条连接。
// 一项是“哪条连接的哪个会话在操作哪个应用”。回合结束、连接断开时撤掉对应的项，表空了提示就收起。
import Foundation
import LitchComputerUseCore

final class Activity {
  static let shared = Activity()

  private struct Entry {
    weak var engine: Engine?
    var session: String
    var appKey: String
    var name: String
  }

  private let lock = NSLock()
  private var entries: [String: Entry] = [:]

  private func id(_ engine: Engine, _ session: String, _ appKey: String) -> String {
    "\(ObjectIdentifier(engine).hashValue)|\(session)|\(appKey)"
  }

  func begin(engine: Engine, session: String, appKey: String, name: String) {
    lock.lock()
    entries[id(engine, session, appKey)] = Entry(
      engine: engine, session: session, appKey: appKey, name: name)
    lock.unlock()
    publish()
  }

  /// 一个会话的回合结束了
  func end(engine: Engine, session: String) {
    lock.lock()
    entries = entries.filter { !($0.value.engine === engine && $0.value.session == session) }
    lock.unlock()
    publish()
  }

  /// 一条连接断了
  func endAll(engine: Engine) {
    lock.lock()
    entries = entries.filter { $0.value.engine !== engine && $0.value.engine != nil }
    lock.unlock()
    publish()
  }

  /// 用户按了停止：每一项都记成“本回合停了”并通知主进程，然后清空
  func stopAll() {
    lock.lock()
    let all = Array(entries.values)
    entries.removeAll()
    lock.unlock()
    for entry in all {
      entry.engine?.userStopped(session: entry.session, appKey: entry.appKey, name: entry.name)
    }
    publish()
    Log.write("用户停止了 \(all.count) 项操作")
  }

  private func publish() {
    lock.lock()
    var names: [String] = []
    for entry in entries.values.sorted(by: { $0.name < $1.name }) where !names.contains(entry.name)
    {
      names.append(entry.name)
    }
    lock.unlock()
    Overlay.shared.show(names)
  }
}
