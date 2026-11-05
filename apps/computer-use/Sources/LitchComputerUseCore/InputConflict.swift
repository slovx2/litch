// 只记录会与注入相撞的输入；查看、移动和滚动不改变目标的输入版本。
public struct InputConflict {
  public enum Kind { case keyDown, keyUp, mouseDown, mouseUp, move, scroll, activate }
  private var revisions: [Int32: UInt64] = [:]
  private var keys: Set<Int> = []
  private var buttons: Set<Int> = []

  public init() {}
  public mutating func note(_ kind: Kind, pid: Int32, code: Int = 0) {
    switch kind {
    case .keyDown: keys.insert(code)
    case .keyUp: keys.remove(code)
    case .mouseDown: buttons.insert(code)
    case .mouseUp: buttons.remove(code)
    default: break
    }
    if kind == .keyDown || kind == .mouseDown {
      revisions[pid, default: 0] &+= 1
    }
  }
  public func revision(pid: Int32) -> UInt64 { revisions[pid, default: 0] }
  public var pointerHeld: Bool { !buttons.isEmpty }
  public func blocked(background: Bool, composing: Bool = false) -> Bool {
    !background && (!buttons.isEmpty || !keys.isEmpty || composing)
  }
  public func collided(background: Bool, pid: Int32, since: UInt64) -> Bool {
    !background && revision(pid: pid) != since
  }
}
