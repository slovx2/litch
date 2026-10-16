// 入口。由 Litch 主进程经 LaunchServices 打开（open -n -g -a），这样它自己是“责任进程”，
// 辅助功能和屏幕录制的授权记在它名下，不记在 Litch 头上（实测见交回报告的 V0 ④）。
//
// 环境变量（主进程打开时经 open --env 交过来）：
//   LITCH_COMPUTER_USE_DIR    套接字和日志所在的目录（默认 ~/Library/Application Support/Litch/computer-use）
//   LITCH_COMPUTER_USE_TOKEN  开发期（助手没有团队号时）的一次性令牌，正式版不认
// 命令行：
//   --diagnostics [文件]      把进程号、父进程、责任进程、签名打成 JSON（写进文件或标准输出）就退出，自检用
import AppKit
import Foundation
import LitchComputerUseCore

let environment = ProcessInfo.processInfo.environment
let arguments = CommandLine.arguments

if let flag = arguments.firstIndex(of: "--diagnostics") {
  let report = (try? Wire.frame(Diagnostics.collect()).dropFirst(4)) ?? Data()
  if arguments.count > flag + 1 {
    FileManager.default.createFile(atPath: arguments[flag + 1], contents: report)
  } else {
    FileHandle.standardOutput.write(report)
    FileHandle.standardOutput.write(Data("\n".utf8))
  }
  exit(0)
}

let directory =
  environment["LITCH_COMPUTER_USE_DIR"]
  ?? (NSHomeDirectory() as NSString).appendingPathComponent(
    "Library/Application Support/Litch/computer-use")
try? FileManager.default.createDirectory(
  atPath: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
chmod(directory, 0o700)
Log.open(directory: directory)

let launchToken = environment["LITCH_COMPUTER_USE_TOKEN"]
// 令牌只给自己用，不留在环境里
unsetenv("LITCH_COMPUTER_USE_TOKEN")
let signing = Diagnostics.ownSigning()
let mode = PeerAuth.mode(ownTeam: signing.teamId, launchToken: launchToken)
Log.write(
  "启动：版本 \(Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "?")，"
    + "团队号 \(signing.teamId ?? "无")，校验方式 \(mode)，"
    + "辅助功能 \(Permissions.accessibility())，屏幕录制 \(Permissions.screenRecording())")

let socketPath = (directory as NSString).appendingPathComponent("helper.sock")
let server = Server(socketPath: socketPath) { connection in
  Engine(connection: connection, mode: mode, ownTeam: signing.teamId)
}
do {
  try server.start()
} catch Server.StartError.alreadyRunning {
  Log.write("已经有一个助手在 \(socketPath) 上了，退出")
  exit(0)
} catch {
  Log.write("起不来：\(error)")
  exit(1)
}

Overlay.shared.onStop = { Activity.shared.stopAll() }
signal(SIGTERM, SIG_IGN)
let termination = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
termination.setEventHandler {
  server.stop()
  exit(0)
}
termination.resume()

let application = NSApplication.shared
application.setActivationPolicy(.accessory)
application.run()
