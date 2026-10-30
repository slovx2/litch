// 动作附带的新树可能来自新窗口；它可供语义动作使用，但不能把旧截图坐标移到新窗口上。
public struct ObservationWindow: Sendable {
  private var observed: UInt32?
  private var captured: UInt32?
  private var applicationObserved = false

  public init() {}

  public mutating func capture(_ window: UInt32) { observe(window); captured = window }
  public mutating func observe(_ window: UInt32?) { observed = window; applicationObserved = window != nil }
  public mutating func observeApplication() { observed = nil; applicationObserved = true }

  public func require(_ window: UInt32?, screenshot: Bool = false) throws {
    guard applicationObserved else { throw RPCError(.stale, "Call get_app_state before acting on this app.") }
    guard observed == window else {
      throw RPCError(.stale, "The active window changed since the latest observation. Call get_app_state again.")
    }
    if screenshot && (window == nil || captured != window) {
      throw RPCError(.stale, "These coordinates belong to the previous window's screenshot. Call get_app_state for a screenshot of the current window, or use an element from the latest action changes.")
    }
  }
}
