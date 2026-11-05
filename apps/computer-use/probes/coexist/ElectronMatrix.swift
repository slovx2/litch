// 冷启动、始终隐藏的 Chromium 控件；实际收件与前台/指针稳定分开记录。
import AppKit

func runElectronMatrix(guardApp: NSRunningApplication) throws {
  let electron = try running("electron")
  let state = try read("electron")
  let raw = state["frame"] as! [String: Double]
  let frame = CGRect(x: raw["x"]!, y: raw["y"]!, width: raw["width"]!, height: raw["height"]!)
  let window = (state["windowId"] as! NSNumber).uint32Value
  let cursor = CGEvent(source: nil)?.location
  func checkScope() throws {
    try safe()
    try assertTest(
      NSWorkspace.shared.frontmostApplication?.processIdentifier == guardApp.processIdentifier
        && CGEvent(source: nil)?.location == cursor
        && (try read("electron")["active"] as? Bool) == false,
      "hidden Electron preserves foreground and physical cursor")
  }
  checks.append([
    "electron": state["electron"] ?? "", "chromium": state["chromium"] ?? "", "hidden": true,
  ])
  for backend in ["public", "public-window", "public-nsevent"] {
    for iteration in 1...3 {
      try command("electron", "reset")
      try checkScope()
      for event in try ProbeInput.events(
        action: "click", point: point("electron", "button"), window: window, frame: frame,
        backend: backend)
      {
        try ProbeInput.send(
          event, pid: electron.processIdentifier, window: window, backend: backend, frame: frame,
          mouse: true)
      }
      Thread.sleep(forTimeInterval: 0.15)
      try checkScope()
      let after = try read("electron")
      checks.append([
        "candidate": "click", "backend": backend, "iteration": iteration,
        "changed": (after["clicks"] as? Int ?? 0) == 1,
        "events": (after["events"] as? [[String: Any]] ?? []).count,
      ])
    }
  }
  for backend in ["public", "public-window"] {
    for action in ["english", "chinese", "english-char", "chinese-char", "keycode"] {
      for iteration in 1...3 {
        try command("electron", "reset")
        try command("electron", "focusText")
        try checkScope()
        for event in try ProbeInput.events(
          action: action, point: point("electron", "text"), window: window, frame: frame,
          backend: backend)
        {
          try safe()
          try ProbeInput.send(
            event, pid: electron.processIdentifier, window: window, backend: backend, frame: frame,
            mouse: false)
          Thread.sleep(forTimeInterval: 0.01)
        }
        Thread.sleep(forTimeInterval: 0.15)
        try checkScope()
        let text = try read("electron")["text"] as? String ?? ""
        let expected = action == "keycode" ? "a" : action.hasPrefix("english") ? "abcXYZ" : "中文测试"
        checks.append([
          "candidate": action, "backend": backend, "iteration": iteration,
          "changed": text == expected, "text": text,
        ])
      }
    }
  }
  for iteration in 1...3 {
    try command("electron", "reset")
    try command("electron", "focusText")
    try Input.type("abc中文", pid: electron.processIdentifier, check: safe)
    Thread.sleep(forTimeInterval: 0.15)
    try checkScope()
    let text = try read("electron")["text"] as? String ?? ""
    checks.append([
      "candidate": "product-text", "backend": "public", "iteration": iteration,
      "changed": text == "abc中文", "text": text,
    ])
  }
}
