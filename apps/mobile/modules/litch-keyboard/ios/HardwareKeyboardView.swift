import ExpoModulesCore
import UIKit

// 只接硬件键盘命令；软键盘的 Return 仍由原来的多行 TextInput 处理。
final class HardwareKeyboardView: ExpoView {
  let onSubmit = EventDispatcher()
  var submitEnabled = false

  private func input(in view: UIView) -> UITextView? {
    if let input = view as? UITextView, input.isFirstResponder { return input }
    for child in view.subviews {
      if let input = input(in: child) { return input }
    }
    return nil
  }

  override var keyCommands: [UIKeyCommand]? {
    guard submitEnabled, let input = input(in: self), input.markedTextRange == nil else { return nil }
    let command = UIKeyCommand(input: "\r", modifierFlags: [], action: #selector(litchSubmit))
    command.wantsPriorityOverSystemBehavior = true
    // 显式注册 Shift 组合，避免普通 Return 命令接管换行。
    let newline = UIKeyCommand(input: "\r", modifierFlags: [.shift], action: #selector(litchInsertNewline))
    newline.wantsPriorityOverSystemBehavior = true
    return [newline, command]
  }

  @objc private func litchInsertNewline() {
    guard let input = input(in: self), input.markedTextRange == nil else { return }
    input.insertText("\n")
  }

  @objc private func litchSubmit() {
    guard submitEnabled, let input = input(in: self), input.markedTextRange == nil else { return }
    onSubmit([:])
  }
}
