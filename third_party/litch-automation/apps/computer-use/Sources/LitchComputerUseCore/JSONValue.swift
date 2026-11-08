// 任意 JSON 值。通道上的参数和结果都用它表示，编解码走 Codable。
import Foundation

public enum JSONValue: Equatable, Sendable {
  case null
  case bool(Bool)
  case number(Double)
  case string(String)
  case array([JSONValue])
  case object([String: JSONValue])

  public subscript(key: String) -> JSONValue? {
    if case .object(let fields) = self { return fields[key] }
    return nil
  }

  public var stringValue: String? {
    if case .string(let text) = self { return text }
    return nil
  }

  public var doubleValue: Double? {
    if case .number(let value) = self { return value }
    return nil
  }

  /// 整数：只认没有小数部分的数
  public var intValue: Int? {
    guard case .number(let value) = self, value.rounded() == value, abs(value) < 1e15 else {
      return nil
    }
    return Int(value)
  }

  public var boolValue: Bool? {
    if case .bool(let value) = self { return value }
    return nil
  }

  public var arrayValue: [JSONValue]? {
    if case .array(let items) = self { return items }
    return nil
  }

  public var objectValue: [String: JSONValue]? {
    if case .object(let fields) = self { return fields }
    return nil
  }
}

extension JSONValue: Codable {
  public init(from decoder: Decoder) throws {
    let container = try decoder.singleValueContainer()
    if container.decodeNil() {
      self = .null
    } else if let value = try? container.decode(Bool.self) {
      self = .bool(value)
    } else if let value = try? container.decode(Double.self) {
      self = .number(value)
    } else if let value = try? container.decode(String.self) {
      self = .string(value)
    } else if let value = try? container.decode([JSONValue].self) {
      self = .array(value)
    } else {
      self = .object(try container.decode([String: JSONValue].self))
    }
  }

  public func encode(to encoder: Encoder) throws {
    var container = encoder.singleValueContainer()
    switch self {
    case .null: try container.encodeNil()
    case .bool(let value): try container.encode(value)
    case .number(let value):
      // 整数照整数写，免得 3 变成 3.0
      if value.rounded() == value, abs(value) < 1e15 {
        try container.encode(Int64(value))
      } else {
        try container.encode(value)
      }
    case .string(let value): try container.encode(value)
    case .array(let value): try container.encode(value)
    case .object(let value): try container.encode(value)
    }
  }
}

extension JSONValue: ExpressibleByStringLiteral, ExpressibleByIntegerLiteral,
  ExpressibleByBooleanLiteral, ExpressibleByDictionaryLiteral, ExpressibleByArrayLiteral,
  ExpressibleByFloatLiteral, ExpressibleByNilLiteral
{
  public init(stringLiteral value: String) { self = .string(value) }
  public init(integerLiteral value: Int) { self = .number(Double(value)) }
  public init(floatLiteral value: Double) { self = .number(value) }
  public init(booleanLiteral value: Bool) { self = .bool(value) }
  public init(nilLiteral: ()) { self = .null }
  public init(arrayLiteral elements: JSONValue...) { self = .array(elements) }
  public init(dictionaryLiteral elements: (String, JSONValue)...) {
    self = .object(Dictionary(elements, uniquingKeysWith: { _, last in last }))
  }
}

extension JSONValue {
  public static func int(_ value: Int) -> JSONValue { .number(Double(value)) }
  public static func optional(_ value: String?) -> JSONValue { value.map { .string($0) } ?? .null }
}
