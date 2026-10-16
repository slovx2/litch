// 把目标应用的关键窗口读成一棵 AXNode。系统对象按读到的先后放进 handles，节点里只记下标。
// 读的范围：关键窗口（没有就主窗口、第一个窗口）整棵树；菜单栏只读顶层几项，展开着的那一项读全。
// 有上限：最多 2000 个元素、40 层、每个元素最多 300 个孩子，免得遇到超大的表格把助手卡住。
import ApplicationServices
import Foundation
import LitchComputerUseCore

final class AXReader {
  static let maxNodes = 2000
  static let maxDepth = 40
  static let maxChildren = 300

  private(set) var handles: [AXUIElement] = []
  private var truncated = false

  /// 读的结果：树、窗口对象和它的位置大小、标题
  struct Result {
    var root: AXNode
    var window: AXUIElement
    var windowFrame: Rect
    var windowTitle: String?
    var handles: [AXUIElement]
    var truncated: Bool
  }

  static func appElement(_ pid: pid_t) -> AXUIElement {
    let element = AXUIElementCreateApplication(pid)
    AXUIElementSetMessagingTimeout(element, 3)
    // Electron、Chromium 的应用默认不建可访问性树，设这个让它建（不支持的应用忽略）
    AXUIElementSetAttributeValue(element, "AXManualAccessibility" as CFString, kCFBooleanTrue)
    return element
  }

  /// 关键窗口：先焦点窗口，再主窗口，再第一个窗口
  static func keyWindow(_ app: AXUIElement) -> AXUIElement? {
    for attribute in [kAXFocusedWindowAttribute, kAXMainWindowAttribute] {
      if let window: AXUIElement = copy(app, attribute as String) { return window }
    }
    if let windows: [AXUIElement] = copy(app, kAXWindowsAttribute as String) {
      return windows.first
    }
    return nil
  }

  static func frame(of element: AXUIElement) -> Rect? {
    guard let position: AXValue = copy(element, kAXPositionAttribute as String),
      let size: AXValue = copy(element, kAXSizeAttribute as String)
    else { return nil }
    var point = CGPoint.zero
    var extent = CGSize.zero
    guard AXValueGetValue(position, .cgPoint, &point), AXValueGetValue(size, .cgSize, &extent)
    else { return nil }
    return Rect(
      x: Double(point.x), y: Double(point.y), width: Double(extent.width),
      height: Double(extent.height))
  }

  static func copy<T>(_ element: AXUIElement, _ attribute: String) -> T? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success,
      let value
    else { return nil }
    return value as? T
  }

  func read(pid: pid_t) throws -> Result {
    let app = AXReader.appElement(pid)
    guard let window = AXReader.keyWindow(app) else {
      throw RPCError(
        .notFound,
        "The app has no window that can be read. Ask the user to open a window, or check that it is not minimized."
      )
    }
    guard let windowFrame = AXReader.frame(of: window) else {
      throw RPCError(.failed, "Could not read the window position.")
    }
    handles = []
    truncated = false
    var children: [AXNode] = []
    if let windowNode = node(window, depth: 0) { children.append(windowNode) }
    if let menuBar: AXUIElement = AXReader.copy(app, kAXMenuBarAttribute as String),
      let menuNode = menu(menuBar)
    {
      children.append(menuNode)
    }
    let root = AXNode(role: "AXGroup", children: children)
    return Result(
      root: root, window: window, windowFrame: windowFrame,
      windowTitle: AXReader.copy(window, kAXTitleAttribute as String), handles: handles,
      truncated: truncated)
  }

  /// 菜单栏：顶层各项；正展开着的那一项读全
  private func menu(_ bar: AXUIElement) -> AXNode? {
    guard var barNode = describe(bar) else { return nil }
    let items: [AXUIElement] = AXReader.copy(bar, kAXChildrenAttribute as String) ?? []
    for item in items.prefix(40) {
      let selected: Bool = AXReader.copy(item, kAXSelectedAttribute as String) ?? false
      if selected, let full = node(item, depth: 1) {
        barNode.children.append(full)
      } else if let leaf = describe(item) {
        barNode.children.append(leaf)
      }
    }
    return barNode
  }

  private func node(_ element: AXUIElement, depth: Int) -> AXNode? {
    guard var current = describe(element) else { return nil }
    guard depth < AXReader.maxDepth else {
      truncated = true
      return current
    }
    let children: [AXUIElement] = AXReader.copy(element, kAXChildrenAttribute as String) ?? []
    if children.count > AXReader.maxChildren { truncated = true }
    for child in children.prefix(AXReader.maxChildren) {
      if handles.count >= AXReader.maxNodes {
        truncated = true
        break
      }
      if let childNode = node(child, depth: depth + 1) { current.children.append(childNode) }
    }
    return current
  }

  private static let attributes: [String] = [
    kAXRoleAttribute, kAXSubroleAttribute, kAXTitleAttribute, kAXDescriptionAttribute,
    kAXValueAttribute, kAXIdentifierAttribute, kAXEnabledAttribute, kAXFocusedAttribute,
    kAXSelectedAttribute, kAXExpandedAttribute, kAXPositionAttribute, kAXSizeAttribute,
    kAXPlaceholderValueAttribute,
  ].map { $0 as String }

  /// 一个元素自己的信息（不含孩子），并登记句柄
  private func describe(_ element: AXUIElement) -> AXNode? {
    guard handles.count < AXReader.maxNodes else {
      truncated = true
      return nil
    }
    var values: CFArray?
    guard
      AXUIElementCopyMultipleAttributeValues(
        element, AXReader.attributes as CFArray, AXCopyMultipleAttributeOptions(rawValue: 0),
        &values) == .success, let list = values as? [Any], list.count == AXReader.attributes.count
    else { return nil }
    func text(_ index: Int) -> String? { AXReader.string(list[index]) }
    func flag(_ index: Int) -> Bool? {
      if let number = list[index] as? NSNumber, CFGetTypeID(number) == CFBooleanGetTypeID() {
        return number.boolValue
      }
      return nil
    }
    guard let role = text(0) else { return nil }
    var states: [String] = []
    if flag(7) == true { states.append("focused") }
    if flag(6) == false { states.append("disabled") }
    if flag(8) == true { states.append("selected") }
    if flag(9) == true { states.append("expanded") }
    var value = text(4)
    if role == "AXCheckBox" || role == "AXRadioButton" {
      if value == "1" { states.append("checked") }
      value = nil
    }
    if let placeholder = text(12), value == nil || value?.isEmpty == true {
      states.append("placeholder: \(placeholder.prefix(60))")
    }
    var frame: Rect?
    if let position = list[10] as AnyObject?, CFGetTypeID(position) == AXValueGetTypeID(),
      let size = list[11] as AnyObject?, CFGetTypeID(size) == AXValueGetTypeID()
    {
      var point = CGPoint.zero
      var extent = CGSize.zero
      if AXValueGetValue(position as! AXValue, .cgPoint, &point),
        AXValueGetValue(size as! AXValue, .cgSize, &extent)
      {
        frame = Rect(
          x: Double(point.x), y: Double(point.y), width: Double(extent.width),
          height: Double(extent.height))
      }
    }
    let title = text(2) ?? text(3)
    handles.append(element)
    return AXNode(
      role: role, subrole: text(1), title: title, value: value, identifier: text(5),
      states: states, frame: frame, handle: handles.count - 1)
  }

  /// 属性值转文字：字符串照用，数字转成文字，别的（包括“没有这个属性”的错误值）当作没有
  static func string(_ value: Any) -> String? {
    if let text = value as? String { return text }
    if let attributed = value as? NSAttributedString { return attributed.string }
    if let number = value as? NSNumber {
      if CFGetTypeID(number) == CFBooleanGetTypeID() { return number.boolValue ? "1" : "0" }
      return number.stringValue
    }
    return nil
  }
}
