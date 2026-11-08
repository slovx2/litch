// 发送有总截止时间，不改变读取端阻塞语义；接收端失联或不读帧不能卡住停止路径。
import Darwin
import Foundation

public enum SocketWriter {
  /// 调用方串行化帧，并给 socket 配置 SO_NOSIGPIPE。失败后须关闭连接，不能接着发半帧。
  public static func write(_ data: Data, to fd: Int32, timeout: TimeInterval = 1) -> Bool {
    var original = timeval()
    var length = socklen_t(MemoryLayout<timeval>.size)
    guard getsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &original, &length) == 0 else { return false }
    defer { setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &original, length) }
    let deadline = ProcessInfo.processInfo.systemUptime + timeout
    return data.withUnsafeBytes { raw in
      guard let base = raw.baseAddress else { return true }
      var offset = 0
      while offset < raw.count {
        let remaining = deadline - ProcessInfo.processInfo.systemUptime
        if remaining <= 0 { return false }
        let micros = max(1, Int(remaining * 1_000_000))
        var budget = timeval(tv_sec: micros / 1_000_000, tv_usec: Int32(micros % 1_000_000))
        guard setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &budget, length) == 0 else { return false }
        let written = Darwin.send(fd, base + offset, raw.count - offset, 0)
        if written > 0 { offset += written; continue }
        if written == 0 { return false }
        if errno == EINTR || errno == EAGAIN || errno == EWOULDBLOCK { continue }
        return false
      }
      return true
    }
  }
}
