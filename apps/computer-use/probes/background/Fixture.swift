// 自有 AppKit 夹具：真实文本控件、按钮和滚动区；只记录这个窗口收到的事件。
import AppKit
import Foundation

let args = CommandLine.arguments
func argument(_ key: String) -> String {
  guard let index = args.firstIndex(of: key), args.indices.contains(index + 1) else { fatalError(key) }
  return args[index + 1]
}
let folder = URL(fileURLWithPath: argument("--directory"), isDirectory: true)
let role = argument("--role")
try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
let app = NSApplication.shared
app.setActivationPolicy(.regular)
var buttonCount = 0
var events: [[String: Any]] = []
var commandID = ""

let window = NSWindow(
  contentRect: NSRect(x: 80, y: 120, width: 620, height: 430),
  styleMask: [.titled, .closable], backing: .buffered, defer: false)
window.title = "Litch M0 \(role) — 仅测试内容"
let content = NSView(frame: NSRect(x: 0, y: 0, width: 620, height: 430))
window.contentView = content
let label = NSTextField(labelWithString: role == "guard" ? "前台守卫：后台测试不应抢走此窗口焦点" : "后台 AppKit 目标")
label.frame = NSRect(x: 20, y: 390, width: 580, height: 24)
content.addSubview(label)
let text = NSTextView(frame: NSRect(x: 20, y: 270, width: 580, height: 105))
text.isRichText = false
text.font = .systemFont(ofSize: 18)
text.setAccessibilityIdentifier("probe-text")
content.addSubview(text)
final class ButtonAction: NSObject {
  @objc func clicked() { buttonCount += 1 }
}
let action = ButtonAction()
let button = NSButton(title: "计数按钮", target: action, action: #selector(ButtonAction.clicked))
button.frame = NSRect(x: 20, y: 220, width: 160, height: 32)
button.setAccessibilityIdentifier("probe-button")
content.addSubview(button)
let scroll = NSScrollView(frame: NSRect(x: 20, y: 20, width: 580, height: 180))
scroll.hasVerticalScroller = true
scroll.borderType = .bezelBorder
let document = NSTextView(frame: NSRect(x: 0, y: 0, width: 550, height: 2500))
document.isEditable = false
document.string = (1...100).map { "滚动行 \($0) · background input probe" }.joined(separator: "\n")
document.font = .systemFont(ofSize: 16)
scroll.documentView = document
content.addSubview(scroll)
window.makeFirstResponder(text)
window.orderFront(nil)

func point(_ view: NSView) -> [String: Double] {
  let local = NSPoint(x: view.bounds.midX, y: view.bounds.midY)
  let screen = window.convertPoint(toScreen: view.convert(local, to: nil))
  let top = NSScreen.screens.first?.frame.maxY ?? 0
  return ["x": screen.x, "y": top - screen.y]
}
func save() {
  let body: [String: Any] = [
    "kind": "appkit", "pid": getpid(), "role": role, "windowId": window.windowNumber,
    "bundleId": Bundle.main.bundleIdentifier ?? "", "active": app.isActive,
    "keyWindow": window.isKeyWindow, "text": text.string, "clicks": buttonCount,
    "scrollY": scroll.contentView.bounds.origin.y,
    "points": ["text": point(text), "button": point(button), "scroll": point(scroll)],
    "frame": ["x": window.frame.minX, "y": (NSScreen.screens.first?.frame.maxY ?? 0) - window.frame.maxY,
              "width": window.frame.width, "height": window.frame.height],
    "events": events, "commandID": commandID,
  ]
  if let data = try? JSONSerialization.data(withJSONObject: body, options: [.sortedKeys]) {
    try? data.write(to: folder.appendingPathComponent("state.json"), options: .atomic)
  }
}
let monitor = NSEvent.addLocalMonitorForEvents(matching: [.keyDown, .keyUp, .leftMouseDown, .leftMouseUp, .scrollWheel]) { event in
  // 只留测试窗口事件，不监视别的应用，也不记录系统全局键盘内容。
  if event.windowNumber == window.windowNumber {
    let keyboard = event.type == .keyDown || event.type == .keyUp
    events.append(["type": event.type.rawValue, "chars": keyboard ? (event.characters ?? "") : "",
      "keyCode": keyboard ? event.keyCode : 0, "window": event.windowNumber, "time": event.timestamp,
      "localX": event.locationInWindow.x, "localY": event.locationInWindow.y,
      "scrollDeltaY": event.type == .scrollWheel ? event.scrollingDeltaY : 0,
      "scrollInverted": event.type == .scrollWheel ? event.isDirectionInvertedFromDevice : false])
    if events.count > 200 { events.removeFirst(events.count - 200) }
  }
  return event
}
var timer: Timer? = Timer.scheduledTimer(withTimeInterval: 0.05, repeats: true) { _ in
  if let data = try? Data(contentsOf: folder.appendingPathComponent("command.json")),
    let command = (try? JSONSerialization.jsonObject(with: data)) as? [String: String],
    let id = command["id"], id != commandID {
    commandID = id
    switch command["action"] {
    case "activate": window.makeKeyAndOrderFront(nil); app.activate(ignoringOtherApps: true)
    case "reset":
      text.string = ""; buttonCount = 0; events.removeAll()
      scroll.contentView.scroll(to: .zero); scroll.reflectScrolledClipView(scroll.contentView)
    case "focusText": window.makeFirstResponder(text)
    case "quit": app.terminate(nil)
    default: break
    }
  }
  save()
}
save()
app.run()
