// 只读核验本轮保存的富文本，避免把模型说“已加粗”当作验收事实。不操作界面。
import AppKit
import Foundation

let args = CommandLine.arguments
guard args.count == 4, args[1].hasPrefix("/tmp/litch-cu-trial/") else {
  fatalError("需要本轮RTF路径和两段期望文本")
}
let document = try NSAttributedString(url: URL(fileURLWithPath: args[1]),
  options: [.documentType: NSAttributedString.DocumentType.rtf], documentAttributes: nil)
let text = document.string as NSString
func bold(_ expected: String) -> Bool {
  let range = text.range(of: expected)
  guard range.location != NSNotFound else { return false }
  var result = true
  document.enumerateAttribute(.font, in: range) { value, _, _ in
    guard let font = value as? NSFont else { result = false; return }
    if !NSFontManager.shared.traits(of: font).contains(.boldFontMask) { result = false }
  }
  return result
}
let result: [String: Any] = ["text": document.string,
  "paragraphsPresent": text.contains(args[2]) && text.contains(args[3]),
  "secondParagraphBold": bold(args[3]), "firstParagraphBold": bold(args[2])]
let data = try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys])
print(String(decoding: data, as: UTF8.self))
