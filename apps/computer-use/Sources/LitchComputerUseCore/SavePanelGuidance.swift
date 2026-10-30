// 系统保存面板的操作提示：识别到面板再给，不把网页或文档中的“保存”当成系统面板。
import Foundation

public enum SavePanelGuidance {
  /// 文件列表很长时，正文可能截掉底部文件名框；补回同次观察的真实编号，不能让模型猜。
  public static func filenameControl(_ root: AXNode, lines: [AXLine]) -> String {
    guard note(root) != nil,
      let field = descendants(root).first(where: { $0.role == "AXTextField" && $0.identifier == "saveAsNameTextField" }),
      let line = lines.first(where: { $0.handle == field.handle }) else { return "" }
    return "\nSave As control: [\(line.index)] \(line.content). Use set_value to replace the filename; verify it before saving."
  }

  public static func note(_ root: AXNode) -> String? {
    let panel = root.role == "AXSheet" ||
      (root.role == "AXWindow" && ["Save", "保存"].contains(root.title ?? ""))
    if panel {
      let nodes = descendants(root)
      let labels = nodes.filter { $0.role == "AXStaticText" }.map {
        ($0.value ?? $0.title ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
      }
      let filenameLabel = labels.contains { ["Save As:", "Save As", "保存为：", "存储为："].contains($0) }
      let fields = nodes.filter { $0.role == "AXTextField" }
      let save = nodes.contains { $0.role == "AXButton" && ["Save", "保存", "存储"].contains($0.title ?? "") }
      if filenameLabel && !fields.isEmpty && save {
        return "Save panel: enter only the filename (for example note.rtf) in Save As. To choose a folder, press cmd+shift+g, enter the folder path, press Return, then verify the selected destination before clicking Save. A full path in Save As can become a filename in the current folder, including iCloud."
      }
    }
    for child in root.children { if let note = note(child) { return note } }
    return nil
  }

  private static func descendants(_ node: AXNode) -> [AXNode] {
    [node] + node.children.flatMap { descendants($0) }
  }
}
