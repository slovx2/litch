// 可访问性树 → 给模型看的文字。
//
// 助手先把目标窗口的可访问性树读成一棵 AXNode（不带系统对象，便于测试），这里负责三件事：
//   1. 编号：同一个会话、同一个应用里，同一个元素前后几次取状态号码不变；新出现的给新号，号码不重用。
//      “同一个元素”按它在树里的路径认：祖先链上每一层的角色和名字，加上同名兄弟里的第几个。
//   2. 排成文字：一行一个元素，缩进表示层级；没有名字、没有值的容器不单占一行，孩子提上来。
//   3. 差异：和上一次比，只列新增、消失、变了的元素；没有上一次时给全文。
// 文字有长度上限，超了在行与行之间截断，并说明省了多少行。
import Foundation

public struct AXNode: Equatable, Sendable {
  /// 角色，比如 AXButton
  public var role: String
  public var subrole: String?
  /// 名字：标题、说明、占位文字里先有的那个
  public var title: String?
  /// 值（文本框的内容、勾选框的 0/1、静态文字的文字）
  public var value: String?
  /// 开发者给的标识（AXIdentifier），比名字稳定，有就用它认元素
  public var identifier: String?
  /// 状态：focused、disabled、selected、checked、expanded……
  public var states: [String]
  /// 元素在屏幕上的位置（点），读不到是 nil
  public var frame: Rect?
  /// 助手自己记的句柄：读树时第几个系统对象，动作时凭它找回 AXUIElement
  public var handle: Int
  public var children: [AXNode]

  public init(
    role: String, subrole: String? = nil, title: String? = nil, value: String? = nil,
    identifier: String? = nil, states: [String] = [], frame: Rect? = nil, handle: Int = -1,
    children: [AXNode] = []
  ) {
    self.role = role
    self.subrole = subrole
    self.title = title
    self.value = value
    self.identifier = identifier
    self.states = states
    self.frame = frame
    self.handle = handle
    self.children = children
  }
}

/// 排出来的一行
public struct AXLine: Equatable, Sendable {
  public var index: Int
  public var depth: Int
  /// 不含缩进和编号的内容，差异按它比
  public var content: String
  public var handle: Int
  public var frame: Rect?
}

/// 一个会话里一个应用的编号状态
public struct AXIndexBook: Sendable {
  private var keyToIndex: [String: Int] = [:]
  private var next = 1
  /// 上一次排出来的行（按编号），差异用
  public private(set) var previous: [Int: AXLine]? = nil

  public init() {}

  /// 给一棵树编号、排成行。编号表随之更新：这次不在的元素的号码作废，但不重用
  public mutating func lines(for root: AXNode) -> [AXLine] {
    var result: [AXLine] = []
    var seen: [String: Int] = [:]
    walk(root, parentKey: "", depth: 0, into: &result, seen: &seen)
    keyToIndex = seen
    return result
  }

  /// 记下这一次，作为下一次差异的基准
  public mutating func remember(_ lines: [AXLine]) {
    previous = Dictionary(lines.map { ($0.index, $0) }, uniquingKeysWith: { first, _ in first })
  }

  /// 忘掉基准（截图之后、模型要全文时）
  public mutating func forget() {
    previous = nil
  }

  private mutating func walk(
    _ node: AXNode, parentKey: String, depth: Int, into result: inout [AXLine],
    seen: inout [String: Int]
  ) {
    let shown = AXText.isShown(node)
    var key = parentKey
    var childDepth = depth
    if shown {
      let name = node.identifier ?? node.title ?? ""
      let base = "\(parentKey)/\(node.role):\(name)"
      // 同一层里角色和名字都一样的兄弟，按出现的先后区分
      var ordinal = 0
      while seen["\(base)#\(ordinal)"] != nil { ordinal += 1 }
      key = "\(base)#\(ordinal)"
      let index: Int
      if let known = keyToIndex[key] {
        index = known
      } else {
        index = next
        next += 1
      }
      seen[key] = index
      result.append(
        AXLine(
          index: index, depth: depth, content: AXText.describe(node), handle: node.handle,
          frame: node.frame))
      childDepth = depth + 1
    }
    for child in node.children {
      walk(child, parentKey: key, depth: childDepth, into: &result, seen: &seen)
    }
  }
}

public enum AXText {
  /// 全文的默认上限（字符）
  public static let defaultLimit = 16_000
  /// 动作之后附带的差异的上限
  public static let actionDiffLimit = 4_000

  /// 只是用来套东西、自己没有名字和值的容器，不单占一行
  static let containerRoles: Set<String> = [
    "AXGroup", "AXSplitGroup", "AXScrollArea", "AXLayoutArea", "AXLayoutItem", "AXUnknown",
    "AXSplitter", "AXMatte", "AXGrowArea",
  ]

  public static func isShown(_ node: AXNode) -> Bool {
    if !containerRoles.contains(node.role) { return true }
    return nonEmpty(node.title) != nil || nonEmpty(node.value) != nil
      || nonEmpty(node.identifier) != nil
  }

  /// 一个元素的描述：角色（去掉 AX 前缀）、名字、值、状态
  public static func describe(_ node: AXNode) -> String {
    var text = strip(node.role)
    if let subrole = nonEmpty(node.subrole) { text += "(\(strip(subrole)))" }
    if let title = nonEmpty(node.title) { text += " \(quote(title, limit: 120))" }
    if let value = nonEmpty(node.value), value != node.title {
      text += " = \(quote(value, limit: 300))"
    }
    if !node.states.isEmpty { text += " {\(node.states.joined(separator: ", "))}" }
    return text
  }

  /// 全文
  public static func render(_ lines: [AXLine], limit: Int = defaultLimit) -> String {
    let rendered = lines.map { "\(String(repeating: "  ", count: $0.depth))[\($0.index)] \($0.content)" }
    return cut(rendered, limit: limit)
  }

  /// 和上一次的差异。没有上一次时回 nil（调用方给全文）
  public static func diff(previous: [Int: AXLine]?, current: [AXLine], limit: Int = defaultLimit)
    -> String?
  {
    guard let previous else { return nil }
    var rows: [String] = []
    var present = Set<Int>()
    for line in current {
      present.insert(line.index)
      if let before = previous[line.index] {
        if before.content != line.content { rows.append("~ [\(line.index)] \(line.content)") }
      } else {
        rows.append("+ [\(line.index)] \(line.content)")
      }
    }
    for index in previous.keys.sorted() where !present.contains(index) {
      if let before = previous[index] { rows.append("- [\(index)] \(before.content)") }
    }
    if rows.isEmpty { return "(no changes since the last state)" }
    return cut(rows, limit: limit)
  }

  /// 在行与行之间截到上限以内
  static func cut(_ rows: [String], limit: Int) -> String {
    var used = 0
    var kept: [String] = []
    for row in rows {
      let cost = row.count + 1
      if used + cost > limit, !kept.isEmpty { break }
      kept.append(row)
      used += cost
    }
    var text = kept.joined(separator: "\n")
    if kept.count < rows.count {
      text += "\n… (\(rows.count - kept.count) more lines not shown)"
    }
    return text
  }

  static func strip(_ role: String) -> String {
    role.hasPrefix("AX") ? String(role.dropFirst(2)) : role
  }

  static func nonEmpty(_ text: String?) -> String? {
    guard let text else { return nil }
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    return trimmed.isEmpty ? nil : trimmed
  }

  /// 加引号，换行写成 \n，过长截断
  static func quote(_ text: String, limit: Int) -> String {
    var body = text.replacingOccurrences(of: "\\", with: "\\\\")
      .replacingOccurrences(of: "\"", with: "\\\"")
      .replacingOccurrences(of: "\n", with: "\\n")
      .replacingOccurrences(of: "\r", with: "")
    if body.count > limit { body = String(body.prefix(limit)) + "…" }
    return "\"\(body)\""
  }
}
