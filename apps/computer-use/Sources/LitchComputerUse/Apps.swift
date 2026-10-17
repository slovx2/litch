// 权限状态、在跑的应用、把应用切到前台。
//
// 查权限只用不弹窗的检查：AXIsProcessTrusted、CGPreflightScreenCaptureAccess，看一眼、拉起助手都不会弹系统的框。
// 只有用户在 Litch 的设置里点“打开系统设置”时才向系统申请（带提示的 AXIsProcessTrustedWithOptions、
// CGRequestScreenCaptureAccess）：系统借此把助手登记进“隐私与安全性”的列表，用户只要打开开关，
// 不用自己去找应用包（它在 Litch.app 里面，文件选择框里进不去）。系统可能顺带弹它自己的提示框。
import AppKit
import ApplicationServices
import CoreGraphics
import Foundation
import ScreenCaptureKit
import LitchComputerUseCore

enum Permissions {
  static func accessibility() -> Bool { AXIsProcessTrusted() }
  static func screenRecording() -> Bool { CGPreflightScreenCaptureAccess() }

  static func status() -> JSONValue {
    ["accessibility": .bool(accessibility()), "screenRecording": .bool(screenRecording())]
  }

  /// 向系统申请这一项：没给过时系统把助手加进列表（开关关着），可能弹它自己的提示框；已经给了什么都不做。
  /// 要在主线程上调。助手是从后台拉起的（open -g），申请前先切到前台：会议软件、官方的助手申请时都在前台，
  /// 后台应用申请屏幕录制，系统可能既不弹框也不登记。屏幕录制另外再走一遍 ScreenCaptureKit 自己的申请，
  /// 较新的系统上列表认的是这一条
  static func request(_ pane: String) {
    switch pane {
    case "accessibility":
      if !accessibility() {
        NSApp.activate()
        let key = kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String
        _ = AXIsProcessTrustedWithOptions([key: true] as CFDictionary)
      }
    case "screenRecording":
      if !screenRecording() {
        NSApp.activate()
        _ = CGRequestScreenCaptureAccess()
        Task {
          _ = try? await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        }
      }
    default: break
    }
  }

  /// 系统设置里“隐私与安全性”的对应一页
  static func settingsURL(_ pane: String) -> URL? {
    let anchor: String
    switch pane {
    case "accessibility": anchor = "Privacy_Accessibility"
    case "screenRecording": anchor = "Privacy_ScreenCapture"
    default: return nil
    }
    return URL(string: "x-apple.systempreferences:com.apple.preference.security?\(anchor)")
  }

  /// 动作要两项权限都在；缺哪项说哪项
  static func require() throws {
    var missing: [String] = []
    if !accessibility() { missing.append("Accessibility") }
    if !screenRecording() { missing.append("Screen Recording") }
    if !missing.isEmpty {
      throw RPCError(.permission, missing.joined(separator: ","))
    }
  }
}

struct AppInfo {
  var name: String
  /// 应用包的文件名去掉 .app（文本编辑是 TextEdit）：系统是中文时 name 是本地化的，模型多半用这个英文名叫它
  var fileName: String?
  var bundleId: String?
  var pid: pid_t
  var active: Bool
  var windows: Int

  var json: JSONValue {
    [
      "name": .string(name), "fileName": .optional(fileName), "bundleId": .optional(bundleId),
      "pid": .int(Int(pid)), "active": .bool(active), "windows": .int(windows),
    ]
  }
}

enum Apps {
  /// 屏幕上各进程的普通窗口（第 0 层）个数。不要屏幕录制权限：只读窗口的归属，不读标题
  static func windowCounts() -> [pid_t: Int] {
    let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
    guard let list = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]]
    else { return [:] }
    var counts: [pid_t: Int] = [:]
    for window in list {
      guard let layer = window[kCGWindowLayer as String] as? Int, layer == 0,
        let owner = window[kCGWindowOwnerPID as String] as? Int
      else { continue }
      counts[pid_t(owner), default: 0] += 1
    }
    return counts
  }

  /// 应用包的文件名去掉 .app
  static func fileName(_ app: NSRunningApplication) -> String? {
    app.bundleURL?.deletingPathExtension().lastPathComponent
  }

  /// 在跑的、有窗口的普通应用
  static func list() -> [AppInfo] {
    let counts = windowCounts()
    let front = NSWorkspace.shared.frontmostApplication?.processIdentifier
    return NSWorkspace.shared.runningApplications
      .filter { $0.activationPolicy == .regular && !$0.isTerminated }
      .compactMap { app -> AppInfo? in
        let windows = counts[app.processIdentifier] ?? 0
        guard windows > 0 else { return nil }
        return AppInfo(
          name: app.localizedName ?? app.bundleIdentifier ?? "pid \(app.processIdentifier)",
          fileName: fileName(app), bundleId: app.bundleIdentifier, pid: app.processIdentifier,
          active: app.processIdentifier == front, windows: windows)
      }
      .sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
  }

  /// 按包标识、名字或包的文件名找在跑的应用。有好几个实例时挑有窗口的、在前台的
  static func resolve(_ query: String) throws -> NSRunningApplication {
    let needle = query.trimmingCharacters(in: .whitespaces)
    guard !needle.isEmpty else { throw RPCError(.invalid, "app is empty") }
    let running = NSWorkspace.shared.runningApplications.filter {
      $0.activationPolicy == .regular && !$0.isTerminated
    }
    var matches = running.filter { $0.bundleIdentifier == needle }
    if matches.isEmpty {
      matches = running.filter {
        $0.localizedName?.compare(needle, options: [.caseInsensitive, .diacriticInsensitive])
          == .orderedSame
      }
    }
    if matches.isEmpty {
      matches = running.filter {
        fileName($0)?.compare(needle, options: [.caseInsensitive, .diacriticInsensitive])
          == .orderedSame
      }
    }
    if matches.isEmpty {
      matches = running.filter {
        $0.bundleIdentifier?.compare(needle, options: .caseInsensitive) == .orderedSame
      }
    }
    guard !matches.isEmpty else {
      throw RPCError(
        .notFound,
        "No running app matches \"\(query)\". Call list_apps to see running apps; if it is not running, ask the user to open it."
      )
    }
    let counts = windowCounts()
    return matches.max { a, b in
      let scoreA = (a.isActive ? 2 : 0) + ((counts[a.processIdentifier] ?? 0) > 0 ? 1 : 0)
      let scoreB = (b.isActive ? 2 : 0) + ((counts[b.processIdentifier] ?? 0) > 0 ? 1 : 0)
      return scoreA < scoreB
    }!
  }

  /// 把应用切到前台。macOS 14 起后台应用调 activate 可能被系统拒（要让出焦点的才行），
  /// 所以经辅助功能设它的 AXFrontmost，再等它真的到前台，最多等 1.5 秒
  static func activate(_ app: NSRunningApplication, window: AXUIElement?) throws {
    let pid = app.processIdentifier
    if NSWorkspace.shared.frontmostApplication?.processIdentifier != pid {
      let element = AXUIElementCreateApplication(pid)
      AXUIElementSetAttributeValue(element, kAXFrontmostAttribute as CFString, kCFBooleanTrue)
      app.activate(options: [])
      let deadline = Date().addingTimeInterval(1.5)
      while NSWorkspace.shared.frontmostApplication?.processIdentifier != pid, Date() < deadline {
        Thread.sleep(forTimeInterval: 0.05)
      }
      guard NSWorkspace.shared.frontmostApplication?.processIdentifier == pid else {
        throw RPCError(
          .failed,
          "Could not bring \(app.localizedName ?? "the app") to the front. Try again; if it keeps failing, ask the user to switch to it."
        )
      }
    }
    if let window {
      AXUIElementPerformAction(window, kAXRaiseAction as CFString)
    }
  }
}
