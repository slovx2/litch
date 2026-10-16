// 本机 unix 套接字服务。目录只有属主能进（0700），套接字文件只有属主能读写（0600）。
// 每条连接一个线程，按顺序处理请求；写帧加锁，屏幕提示那边发通知时也走同一把锁。
// 同一个目录里已经有一个活着的助手时（能连上它的套接字），自己退出，不抢。
// 没有任何连接满 60 秒就自己退出：主进程没了、不需要了，都不该留下一个常驻的后台进程。
import Darwin
import Foundation
import LitchComputerUseCore

final class Server {
  let socketPath: String
  private var listenFD: Int32 = -1
  private let lock = NSLock()
  private var connections: [Int: Connection] = [:]
  private var nextId = 1
  private var idleSince: Date? = Date()
  let makeHandler: (Connection) -> ConnectionHandler

  static let idleExitSeconds: TimeInterval = 60

  init(socketPath: String, makeHandler: @escaping (Connection) -> ConnectionHandler) {
    self.socketPath = socketPath
    self.makeHandler = makeHandler
  }

  enum StartError: Error {
    case pathTooLong
    case alreadyRunning
    case system(String)
  }

  func start() throws {
    var address = sockaddr_un()
    address.sun_family = sa_family_t(AF_UNIX)
    let bytes = Array(socketPath.utf8)
    let capacity = MemoryLayout.size(ofValue: address.sun_path)
    guard bytes.count < capacity else { throw StartError.pathTooLong }

    if FileManager.default.fileExists(atPath: socketPath) {
      if Server.isAlive(socketPath) { throw StartError.alreadyRunning }
      unlink(socketPath)
    }

    let fd = socket(AF_UNIX, SOCK_STREAM, 0)
    guard fd >= 0 else { throw StartError.system("socket: \(errno)") }
    withUnsafeMutableBytes(of: &address.sun_path) { raw in
      raw.copyBytes(from: bytes)
      raw[bytes.count] = 0
    }
    // 先收紧掩码再 bind，套接字文件一生出来就是 0600，没有可被别人连上的空档
    let oldMask = umask(0o177)
    let bound = withUnsafePointer(to: &address) {
      $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
        bind(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
      }
    }
    umask(oldMask)
    guard bound == 0 else {
      close(fd)
      throw StartError.system("bind: \(errno)")
    }
    chmod(socketPath, 0o600)
    guard listen(fd, 8) == 0 else {
      close(fd)
      throw StartError.system("listen: \(errno)")
    }
    listenFD = fd
    let acceptThread = Thread { [weak self] in self?.acceptLoop() }
    acceptThread.name = "accept"
    acceptThread.start()
    let idleThread = Thread { [weak self] in self?.idleLoop() }
    idleThread.name = "idle"
    idleThread.start()
  }

  /// 能连上就说明有活着的助手在听
  static func isAlive(_ path: String) -> Bool {
    let fd = socket(AF_UNIX, SOCK_STREAM, 0)
    guard fd >= 0 else { return false }
    defer { close(fd) }
    var address = sockaddr_un()
    address.sun_family = sa_family_t(AF_UNIX)
    let bytes = Array(path.utf8)
    guard bytes.count < MemoryLayout.size(ofValue: address.sun_path) else { return false }
    withUnsafeMutableBytes(of: &address.sun_path) { raw in
      raw.copyBytes(from: bytes)
      raw[bytes.count] = 0
    }
    let result = withUnsafePointer(to: &address) {
      $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
        connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
      }
    }
    return result == 0
  }

  func stop() {
    if listenFD >= 0 {
      close(listenFD)
      listenFD = -1
    }
    unlink(socketPath)
  }

  private func acceptLoop() {
    while listenFD >= 0 {
      let fd = accept(listenFD, nil, nil)
      if fd < 0 {
        if errno == EINTR { continue }
        return
      }
      // 对面先断开时写会触发 SIGPIPE；这里改成写出错
      var on: Int32 = 1
      setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &on, socklen_t(MemoryLayout<Int32>.size))
      lock.lock()
      let id = nextId
      nextId += 1
      let connection = Connection(id: id, fd: fd, server: self)
      connections[id] = connection
      idleSince = nil
      lock.unlock()
      Log.write("连接 #\(id) 进来")
      connection.handler = makeHandler(connection)
      let thread = Thread { connection.run() }
      thread.name = "connection-\(id)"
      thread.start()
    }
  }

  fileprivate func closed(_ connection: Connection) {
    lock.lock()
    connections[connection.id] = nil
    if connections.isEmpty { idleSince = Date() }
    lock.unlock()
    Log.write("连接 #\(connection.id) 断开")
  }

  private func idleLoop() {
    while true {
      Thread.sleep(forTimeInterval: 5)
      lock.lock()
      let since = idleSince
      lock.unlock()
      if let since, Date().timeIntervalSince(since) > Server.idleExitSeconds {
        Log.write("没有连接满 \(Int(Server.idleExitSeconds)) 秒，退出")
        stop()
        exit(0)
      }
    }
  }

  /// 给所有已握手的连接发一条通知
  func broadcast(_ method: String, _ params: JSONValue, where accept: (Connection) -> Bool) {
    lock.lock()
    let all = Array(connections.values)
    lock.unlock()
    for connection in all where connection.authenticated && accept(connection) {
      connection.send(RPC.notification(method, params))
    }
  }
}

/// 一条连接收到的请求交给谁
protocol ConnectionHandler: AnyObject {
  /// 处理一个请求，回结果或抛 RPCError
  func handle(method: String, params: JSONValue) throws -> JSONValue
  /// 连接断了
  func closed()
}

final class Connection {
  let id: Int
  let fd: Int32
  private weak var server: Server?
  private let writeLock = NSLock()
  var handler: ConnectionHandler?
  /// 握手过了
  var authenticated = false
  private var open = true

  init(id: Int, fd: Int32, server: Server) {
    self.id = id
    self.fd = fd
    self.server = server
  }

  func send(_ value: JSONValue) {
    guard let data = try? Wire.frame(value) else {
      Log.write("连接 #\(id)：一帧太大，没有发出去")
      return
    }
    writeLock.lock()
    defer { writeLock.unlock() }
    guard open else { return }
    data.withUnsafeBytes { raw in
      var offset = 0
      while offset < raw.count {
        let written = write(fd, raw.baseAddress! + offset, raw.count - offset)
        if written < 0 {
          if errno == EINTR { continue }
          return
        }
        offset += written
      }
    }
  }

  func run() {
    var reader = FrameReader()
    var buffer = [UInt8](repeating: 0, count: 64 * 1024)
    loop: while true {
      let count = read(fd, &buffer, buffer.count)
      if count < 0 && errno == EINTR { continue }
      if count <= 0 { break }
      reader.append(Data(buffer[0..<count]))
      do {
        while let frame = try reader.next() {
          if !dispatch(frame) { break loop }
        }
      } catch {
        Log.write("连接 #\(id)：帧不对（\(error)），断开")
        break
      }
    }
    shutdown()
  }

  /// 处理一帧；回 false 表示要断开
  private func dispatch(_ frame: JSONValue) -> Bool {
    guard let message = RPCMessage.parse(frame) else { return true }
    switch message {
    case .notification(let method, let params):
      _ = try? handler?.handle(method: method, params: params)
      return authenticated
    case .request(let id, let method, let params):
      do {
        let result = try handler?.handle(method: method, params: params) ?? .null
        send(RPC.result(id: id, result))
      } catch let error as RPCError {
        send(RPC.error(id: id, error))
        // 没握手成功就断开
        if !authenticated { return false }
      } catch {
        send(RPC.error(id: id, RPCError(.failed, "\(error)")))
      }
      return true
    }
  }

  func shutdown() {
    writeLock.lock()
    let wasOpen = open
    open = false
    writeLock.unlock()
    guard wasOpen else { return }
    Darwin.shutdown(fd, SHUT_RDWR)
    close(fd)
    handler?.closed()
    handler = nil
    server?.closed(self)
  }
}
