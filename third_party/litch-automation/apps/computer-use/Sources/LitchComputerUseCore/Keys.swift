// 组合键的解析：“cmd+shift+t”“Return”“ctrl+Page_Up”→ 虚拟键码加修饰键。
// 键码是 macOS 的虚拟键码（按美式键盘上的物理位置），字母键在别的键盘布局下按的是同一个位置的键。
// 修饰键的位和 CGEventFlags 一致。名字不分大小写，下划线、连字符忽略（Page_Up、page-up、pageup 一样）。
import Foundation

public struct KeyCombo: Equatable, Sendable {
  public var keyCode: UInt16
  public var flags: UInt64

  public init(keyCode: UInt16, flags: UInt64) {
    self.keyCode = keyCode
    self.flags = flags
  }
}

public enum Keys {
  public static let shift: UInt64 = 0x20000
  public static let control: UInt64 = 0x40000
  public static let option: UInt64 = 0x80000
  public static let command: UInt64 = 0x100000
  public static let function: UInt64 = 0x800000

  static let modifiers: [String: UInt64] = [
    "cmd": command, "command": command, "super": command, "meta": command,
    "ctrl": control, "control": control,
    "alt": option, "option": option, "opt": option,
    "shift": shift,
    "fn": function,
  ]

  static let named: [String: UInt16] = {
    var map: [String: UInt16] = [
      "return": 0x24, "enter": 0x24, "kpenter": 0x4C, "tab": 0x30, "space": 0x31,
      "escape": 0x35, "esc": 0x35, "backspace": 0x33, "delete": 0x33,
      "forwarddelete": 0x75, "del": 0x75, "home": 0x73, "end": 0x77,
      "pageup": 0x74, "prior": 0x74, "pagedown": 0x79, "next": 0x79,
      "left": 0x7B, "arrowleft": 0x7B, "right": 0x7C, "arrowright": 0x7C,
      "down": 0x7D, "arrowdown": 0x7D, "up": 0x7E, "arrowup": 0x7E,
      "help": 0x72, "insert": 0x72,
      "minus": 0x1B, "equal": 0x18, "plus": 0x18, "comma": 0x2B, "period": 0x2F,
      "slash": 0x2C, "semicolon": 0x29, "quote": 0x27, "apostrophe": 0x27,
      "bracketleft": 0x21, "bracketright": 0x1E, "backslash": 0x2A, "grave": 0x32,
    ]
    let functionKeys: [UInt16] = [
      0x7A, 0x78, 0x63, 0x76, 0x60, 0x61, 0x62, 0x64, 0x65, 0x6D, 0x67, 0x6F, 0x69, 0x6B, 0x71,
      0x6A,
    ]
    for (offset, code) in functionKeys.enumerated() { map["f\(offset + 1)"] = code }
    return map
  }()

  static let characters: [Character: UInt16] = [
    "a": 0x00, "s": 0x01, "d": 0x02, "f": 0x03, "h": 0x04, "g": 0x05, "z": 0x06, "x": 0x07,
    "c": 0x08, "v": 0x09, "b": 0x0B, "q": 0x0C, "w": 0x0D, "e": 0x0E, "r": 0x0F, "y": 0x10,
    "t": 0x11, "1": 0x12, "2": 0x13, "3": 0x14, "4": 0x15, "6": 0x16, "5": 0x17, "=": 0x18,
    "9": 0x19, "7": 0x1A, "-": 0x1B, "8": 0x1C, "0": 0x1D, "]": 0x1E, "o": 0x1F, "u": 0x20,
    "[": 0x21, "i": 0x22, "p": 0x23, "l": 0x25, "j": 0x26, "'": 0x27, "k": 0x28, ";": 0x29,
    "\\": 0x2A, ",": 0x2B, "/": 0x2C, "n": 0x2D, "m": 0x2E, ".": 0x2F, "`": 0x32,
  ]

  /// 解析一个组合键。认不出时抛 RPCError(.invalid)，说明写给模型看
  public static func parse(_ text: String) throws -> KeyCombo {
    let trimmed = text.trimmingCharacters(in: .whitespaces)
    guard !trimmed.isEmpty else { throw RPCError(.invalid, "key is empty") }
    var parts = trimmed.split(separator: "+", omittingEmptySubsequences: false).map(String.init)
    // “cmd++”：最后那个加号本身就是键
    if trimmed.hasSuffix("++") {
      parts = Array(parts.dropLast(2)) + ["+"]
    }
    guard let keyName = parts.last, !keyName.isEmpty else {
      throw RPCError(.invalid, "missing key after modifiers in \"\(text)\"")
    }
    var flags: UInt64 = 0
    for raw in parts.dropLast() {
      let name = normalize(raw)
      guard let flag = modifiers[name] else {
        throw RPCError(.invalid, "unknown modifier \"\(raw)\" in \"\(text)\"; use cmd, ctrl, alt, shift or fn")
      }
      flags |= flag
    }
    if let flag = modifiers[normalize(keyName)], parts.count == 1 {
      // 只按一个修饰键：发它自己的键码
      let codes: [UInt64: UInt16] = [
        command: 0x37, shift: 0x38, option: 0x3A, control: 0x3B, function: 0x3F,
      ]
      return KeyCombo(keyCode: codes[flag] ?? 0x37, flags: flag)
    }
    if keyName == "+" { return KeyCombo(keyCode: 0x18, flags: flags | shift) }
    if let code = named[normalize(keyName)] {
      return KeyCombo(keyCode: code, flags: flags)
    }
    if keyName.count == 1, let character = keyName.lowercased().first,
      let code = characters[character]
    {
      return KeyCombo(keyCode: code, flags: flags)
    }
    throw RPCError(
      .invalid,
      "unknown key \"\(keyName)\"; use a single character or a name like Return, Tab, Escape, BackSpace, Delete, Left, Page_Up, F5. To type text use type_text"
    )
  }

  static func normalize(_ name: String) -> String {
    name.lowercased().replacingOccurrences(of: "_", with: "").replacingOccurrences(of: "-", with: "")
      .trimmingCharacters(in: .whitespaces)
  }
}
