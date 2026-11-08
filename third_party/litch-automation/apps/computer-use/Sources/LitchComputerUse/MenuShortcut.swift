// 先按虚拟键码和完整修饰键匹配应用公开的菜单项，避免常用 Command 快捷键一律激活。
// 不靠本地化标题猜测；只有唯一、可用且支持 AXPress 的菜单项才走语义路径。
import ApplicationServices
import Carbon
import LitchComputerUseCore

enum MenuShortcut {
  static func find(pid: pid_t, combo: KeyCombo, check: () throws -> Void) throws -> AXUIElement? {
    guard combo.flags & Keys.command != 0,
      let menu: AXUIElement = AXReader.copy(AXReader.appElement(pid), kAXMenuBarAttribute as String)
    else { return nil }
    var remaining = 400
    var truncated = false
    var matches: [AXUIElement] = []
    let keyCharacter = character(for: combo.keyCode)
    let deadline = ProcessInfo.processInfo.systemUptime + 1
    let attributes = [kAXRoleAttribute, kAXMenuItemCmdCharAttribute, kAXMenuItemCmdGlyphAttribute,
      kAXMenuItemCmdVirtualKeyAttribute, kAXMenuItemCmdModifiersAttribute, kAXEnabledAttribute,
      kAXChildrenAttribute] as CFArray
    func visit(_ item: AXUIElement, depth: Int) throws {
      try check()
      guard remaining > 0, depth < 8, ProcessInfo.processInfo.systemUptime < deadline else {
        truncated = true; return
      }
      remaining -= 1
      AXUIElementSetMessagingTimeout(item, 0.1)
      var values: CFArray?
      guard AXUIElementCopyMultipleAttributeValues(item, attributes,
        AXCopyMultipleAttributeOptions(rawValue: 0), &values) == .success,
        let list = values as? [Any], list.count == 7 else { truncated = true; return }
      let role = list[0] as? String
      let character = list[1] as? String ?? ""
      let glyph = list[2] as? NSNumber
      let virtualKey = list[3] as? NSNumber
      // AppKit 的字母菜单只给 CmdChar；按当前键盘布局翻译物理键，不能假定用户用美式布局。
      let code = virtualKey?.intValue ?? (keyCharacter.map {
        character.compare($0, options: .caseInsensitive) == .orderedSame
      } == true ? Int(combo.keyCode) : -1)
      if role == kAXMenuItemRole,
        !character.isEmpty || (glyph?.intValue ?? 0) != 0,
        let modifiers = list[4] as? NSNumber,
        let enabled = list[5] as? Bool, enabled,
        InputPolicy.menuShortcutMatches(keyCode: code, modifiers: modifiers.intValue, combo: combo) {
        var actions: CFArray?
        if AXUIElementCopyActionNames(item, &actions) == .success,
          (actions as? [String])?.contains(kAXPressAction as String) == true { matches.append(item) }
      }
      let children = list[6] as? [AXUIElement] ?? []
      for child in children { try visit(child, depth: depth + 1) }
    }
    try visit(menu, depth: 0)
    // 遍历截断不能证明唯一。
    return !truncated && matches.count == 1 ? matches[0] : nil
  }

  private static func character(for code: UInt16) -> String? {
    guard let source = TISCopyCurrentKeyboardLayoutInputSource()?.takeRetainedValue(),
      let property = TISGetInputSourceProperty(source, kTISPropertyUnicodeKeyLayoutData) else { return nil }
    let data = Unmanaged<CFData>.fromOpaque(property).takeUnretainedValue()
    guard let bytes = CFDataGetBytePtr(data) else { return nil }
    let layout = UnsafeRawPointer(bytes).assumingMemoryBound(to: UCKeyboardLayout.self)
    var dead: UInt32 = 0, count = 0
    var units = [UniChar](repeating: 0, count: 8)
    let status = UCKeyTranslate(layout, code, UInt16(kUCKeyActionDown), 0, UInt32(LMGetKbdType()),
      OptionBits(kUCKeyTranslateNoDeadKeysMask), &dead, units.count, &count, &units)
    guard status == noErr, count > 0 else { return nil }
    return String(utf16CodeUnits: units, count: count)
  }
}
