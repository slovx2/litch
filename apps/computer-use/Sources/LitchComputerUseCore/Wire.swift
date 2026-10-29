// 通道的线上格式：每一帧是 4 字节大端的长度，后面跟这么多字节的 UTF-8 JSON（JSON-RPC 2.0）。
// 主进程那一头的实现在 apps/desktop/src/computer-use/wire.mts，两边的常量要一致。
import Foundation

public enum Wire {
  /// 通道协议的版本。握手时两边对不上就断开，不猜
  public static let protocolVersion = 1
  /// 单帧上限（截图编码之后最大也就几 MB，留足余量）
  public static let maxFrame = 32 * 1024 * 1024

  /// 把一个 JSON 值编成一帧
  public static func frame(_ value: JSONValue) throws -> Data {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.withoutEscapingSlashes]
    let body = try encoder.encode(value)
    guard body.count <= maxFrame else { throw WireError.frameTooLarge(body.count) }
    var length = UInt32(body.count).bigEndian
    var data = Data(bytes: &length, count: 4)
    data.append(body)
    return data
  }
}

public enum WireError: Error, Equatable {
  case frameTooLarge(Int)
  case badJSON
}

/// 把读到的字节攒起来，切出完整的帧
public struct FrameReader {
  private var buffer = Data()

  public init() {}

  public mutating func append(_ data: Data) {
    buffer.append(data)
  }

  /// 取下一帧；不够一帧时回 nil。长度超限、内容不是 JSON 时抛错（调用方应当断开连接）
  public mutating func next() throws -> JSONValue? {
    guard buffer.count >= 4 else { return nil }
    let start = buffer.startIndex
    let length =
      Int(buffer[start]) << 24 | Int(buffer[start + 1]) << 16 | Int(buffer[start + 2]) << 8
      | Int(buffer[start + 3])
    guard length <= Wire.maxFrame else { throw WireError.frameTooLarge(length) }
    guard buffer.count >= 4 + length else { return nil }
    let body = buffer.subdata(in: (start + 4)..<(start + 4 + length))
    buffer.removeSubrange(start..<(start + 4 + length))
    // 剩下的挪到从零开始，下标好算
    buffer = Data(buffer)
    do {
      return try JSONDecoder().decode(JSONValue.self, from: body)
    } catch {
      throw WireError.badJSON
    }
  }
}

/// JSON-RPC 的错误码。-32xxx 是 JSON-RPC 自己的，其余是我们的；主进程按 `data.kind` 认（见 RPCErrorKind）
public enum RPCErrorKind: String, Sendable {
  /// 没握手、版本不对、验签没过
  case unauthorized
  /// 参数不对、序号不存在、坐标出了截图
  case invalid
  /// 系统权限没给
  case permission
  /// 实际采集等待系统确认、被用户拒绝或其他失败；与 TCC 预检分开。
  case capturePending, captureDenied, captureFailed
  /// 找不到应用、应用没有窗口
  case notFound
  /// 用户在这个回合里停掉了这个应用
  case stopped
  /// 用户正在动这个应用，等一会儿
  case userActive
  /// 窗口变了，要先重新取状态
  case stale
  /// 系统接口出错
  case failed
}

public struct RPCError: Error, Equatable {
  public var kind: RPCErrorKind
  public var message: String

  public init(_ kind: RPCErrorKind, _ message: String) {
    self.kind = kind
    self.message = message
  }

  public var code: Int {
    switch kind {
    case .invalid: return -32602
    case .unauthorized: return -32001
    default: return -32000
    }
  }

  public var json: JSONValue {
    ["code": .int(code), "message": .string(message), "data": ["kind": .string(kind.rawValue)]]
  }
}

/// 收到的一条消息
public enum RPCMessage: Equatable {
  case request(id: JSONValue, method: String, params: JSONValue)
  case notification(method: String, params: JSONValue)

  /// 解析一帧。不是请求或通知（比如对面发来的应答）时回 nil
  public static func parse(_ value: JSONValue) -> RPCMessage? {
    guard case .object(let fields) = value, let method = fields["method"]?.stringValue else {
      return nil
    }
    let params = fields["params"] ?? .object([:])
    if let id = fields["id"], id != .null {
      return .request(id: id, method: method, params: params)
    }
    return .notification(method: method, params: params)
  }
}

public enum RPC {
  public static func result(id: JSONValue, _ result: JSONValue) -> JSONValue {
    ["jsonrpc": "2.0", "id": id, "result": result]
  }

  public static func error(id: JSONValue, _ error: RPCError) -> JSONValue {
    ["jsonrpc": "2.0", "id": id, "error": error.json]
  }

  public static func notification(_ method: String, _ params: JSONValue) -> JSONValue {
    ["jsonrpc": "2.0", "method": .string(method), "params": params]
  }
}
