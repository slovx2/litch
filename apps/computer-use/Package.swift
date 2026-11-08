// swift-tools-version:5.9
// Litch Computer Use：替 Litch 操作 macOS 上别的应用的原生助手（无界面，LSUIElement）。
// 辅助功能、屏幕录制两项系统权限授给它，不授给 Litch.app。
//
// 两个目标：
//   LitchComputerUseCore  不碰系统接口的纯逻辑（帧编解码、JSON-RPC、坐标换算、可访问性文本与差异、按键解析、
//                         验签规则），全部能 swift test
//   LitchComputerUse      可执行文件本体：套接字服务、验签、可访问性、截图、键鼠事件、屏幕提示
// 不引第三方依赖。组装成 .app 并签名见 build-app.mjs。
import PackageDescription

let package = Package(
  name: "LitchComputerUse",
  platforms: [.macOS(.v14)],
  targets: [
    .target(name: "LitchComputerUseCore"),
    .executableTarget(
      name: "LitchComputerUse",
      dependencies: ["LitchComputerUseCore"],
      linkerSettings: [
        .linkedFramework("AppKit"),
        .linkedFramework("ApplicationServices"),
        .linkedFramework("ScreenCaptureKit"),
        .linkedFramework("Security"),
      ]
    ),
    .testTarget(name: "LitchComputerUseCoreTests", dependencies: ["LitchComputerUseCore"]),
    .testTarget(name: "LitchComputerUseTests", dependencies: ["LitchComputerUse", "LitchComputerUseCore"]),
  ]
)
