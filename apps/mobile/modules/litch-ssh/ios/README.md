# iOS 原生构建

在仓库根目录与 `apps/mobile`、`packages/ui` 各执行 `npm ci`。需要 Xcode、CocoaPods 和
`mobile/go.mod` 指定的 Go 版本。Apple Silicon 模拟器与 arm64 真机共用同一 XCFramework；
不提交二进制、Pods 或 Expo 生成的工程。

```sh
cd apps/mobile
LITCH_MOBILE_DEV=1 bash scripts/build-ios.sh
```

脚本先生成 WebView 页面与 Go XCFramework，再运行 Expo prebuild、pod install 和无签名
Release 模拟器构建。`LITCH_IOS_DESTINATION` 可以指定某台模拟器；真机签名在 Xcode 配置。
开发包使用 `dev.litch.app.dev` 和 `litch-dev://`，与正式应用隔离。

`ConnectionLifecycle` 使用应用级前后台通知，不把失焦当作后台。五分钟 Go deadline 与 iOS
后台任务执行期限取先到者；提前到期也通过 Go 的 epoch 校验统一关闭连接并暂停重连。
回前台取消期限并通知 JS 核心恢复。不申请后台常驻或 VPN 权限。

## 原生验收

先用 `apps/mobile/scripts/fixture.mjs` 启动隔离 SSH 夹具，安装开发包，并使用以
`Litch-iOS-` 开头的专用模拟器。`scripts/check-ios.mjs` 复用手机端 Maestro 流程；
`scripts/check-ios-terminal.mjs <UDID> <fixture.json>` 使用独立 XCUITest 验证终端的
逐字符输入、系统粘贴及拒绝、空剪贴板、中文拼音候选、真实后台到期与前台重连。
后者需要 CocoaPods 环境中的 Ruby `xcodeproj 1.28.1`（必要时设置对应的 `GEM_HOME`）。
中文用例使用模拟器的简体拼音与 English (US) 键盘。

两种执行器都只接受隔离夹具，并自动清理临时测试工程、截图和报告。不能同时操作同一台
模拟器；Maestro 另通过全机 `/tmp/litch-maestro-7001.lock` 排队使用驱动端口。

## 分发准备

模拟器构建不需要签名，但不能交给 iPhone 用户安装。建议先通过 TestFlight 完成真机测试，
正式长期分发使用 App Store。TestFlight 每个构建最多测试 90 天，支持最多 100 位内部测试者
和 10,000 位外部测试者；首个外部测试构建需要审核，后续构建也可能需要审核。
见 [Apple TestFlight 文档](https://developer.apple.com/help/app-store-connect/test-a-beta-version/testflight-overview/)。

发布负责人需要准备：

- Apple Developer Program 团队、Team ID、构建者及上传者的相应权限。
- 注册正式 Bundle ID `dev.litch.app`，并创建对应 App Store Connect App 记录。
- Apple Distribution 证书及私钥、App Store 分发描述文件，或授权 Xcode 自动管理签名。
- 自动上传时使用 App Store Connect API key（Key ID、Issuer ID 与 `.p8`）；它不替代代码签名。
  凭据进入构建机的安全存储，不放进仓库或聊天。
- 隐私政策与支持地址、商店截图、年龄评级、发行地区、审核说明，以及可供审核的测试连接方式。
- 对正式归档生成隐私报告，检查应用和每个静态框架实际打包的 `PrivacyInfo.xcprivacy`。
  所需理由 API、数据收集声明与 App Store 隐私问卷需根据最终依赖及服务的数据流填写。

SSH 和内嵌网络包含加密实现，上传 TestFlight 也要完成出口合规判定。不能仅凭“开源”或
“使用标准算法”写死 `ITSAppUsesNonExemptEncryption=false`；发布负责人应按算法与发行地区
完成 App Store Connect 问卷，确定是否需要 CCATS 或法国相关材料。
见 [Apple 出口合规说明](https://developer.apple.com/help/app-store-connect/manage-app-information/overview-of-export-compliance/)。

iOS 更新由 App Store 或 TestFlight 管理。应用内显示渠道说明，不下载或自行安装 Android
安装包；有确定的商店页面或 TestFlight 邀请链接后，才配置对应跳转地址。
