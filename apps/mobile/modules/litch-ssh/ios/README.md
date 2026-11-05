# iOS 原生构建

在仓库根目录与 `apps/mobile`、`packages/ui` 各执行 `npm ci`。需要 Xcode、CocoaPods 和
`mobile/go.mod` 指定的 Go 版本。Apple Silicon 模拟器与 arm64 真机共用同一 XCFramework；
不提交二进制、Pods 或 Expo 生成的工程。

```sh
cd apps/mobile
LITCH_MOBILE_DEV=1 bash scripts/build-ios.sh
```

脚本先生成 WebView 页面与 Go XCFramework，再运行 Expo prebuild、pod install 和本地 ad-hoc
签名的 Release 模拟器构建，不需要 Apple 账号。`LITCH_IOS_DESTINATION` 可以指定某台模拟器；
真机签名在 Xcode 配置。`LITCH_IOS_UNSIGNED=1` 只用于 CI 编译检查，不能验收 Keychain 流程。
开发包使用 `dev.litch.app.dev` 和 `litch-dev://`，与正式应用隔离。

Keychain access group 在 `app.json` 的 `ios.entitlements` 声明，经 prebuild 生成；使用
`AppIdentifierPrefix` 与实际 bundle ID，因此正式签名会使用真实团队的前缀，开发包也不共用密钥。

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

内嵌网络的原生连通性用 `scripts/check-ios-network.mjs <UDID> <fixture.json> <tailnet.json>`。
先运行 `mobile/testfixture/tailnet` 中的本地 HTTPS 控制面；用单独的 `Litch-iOS-Network` 模拟器，
脚本会安装临时 CA，结束后重置该模拟器的 Keychain 并卸载测试宿主。测试宿主使用生产
Keychain/Go 桥代码与同一 XCFramework，覆盖 MagicDNS、SSH 凭据、后台暂停恢复和退出清理。
该原生用例不是设置页面或真实 Apple 签名的替代；页面另用 Maestro 验收。
给同一命令追加 `ui`，可用 XCUITest 在已安装的签名开发包里验证设置页和真实后台恢复，
不占用 Maestro 端口；同样只操作专用网络模拟器并在退出时移除测试 CA。
`fixture/26-tailscale.yaml` 验未登录与 HTTPS 输入保护；`ios/tailscale.yaml` 验本地控制面登录、
真实后台到期恢复、退出和清除。后一条给 `check-ios.mjs` 设置 `LITCH_TEST_TAILNET=<tailnet.json>`，
并先把 JSON 中的 CA 装入专用模拟器；用完必须删除模拟器或重置其 Keychain。

## 内嵌网络的存储与披露

节点完整 JSON 以 Keychain generic password 保存，属性为
`AfterFirstUnlockThisDeviceOnly`、不参加 iCloud 同步；存储错误直接返回 Go。
节点私有目录排除备份，使用首次解锁前不可访问的文件保护。回前台主动查询节点状态，恢复
被系统后台期限暂停的节点；不申请 Network Extension 或系统 VPN 权限。

`build-ssh-ios.sh` 从 Go 依赖清单生成完整第三方许可，写入 `LitchSshPrivacy.bundle`。
两份 XCFramework 切片均附 `PrivacyInfo.xcprivacy`；podspec 另把隐私清单打进 App 的资源包，
防止静态链接时丢失。理由声明对应应用私有文件元数据、连接计时和本应用 UserDefaults。
理由代码以 [Apple required reason API 文档](https://developer.apple.com/documentation/bundleresources/app-privacy-configuration/nsprivacyaccessedapitypes/nsprivacyaccessedapitype) 为准。

Tailscale 是可选网络服务：用户登录时，所选控制服务器接收节点标识、节点名称、网络地址等
网络元数据，并可能与用户账号关联；中继服务器处理加密流量。清单按应用功能声明设备标识和
其他数据，不用于跟踪。节点秘密仅存手机 Keychain，不经过 JS；SSH 凭据不交给控制服务器。
Go 侧关闭日志上传。发布负责人仍须据正式依赖与控制服务政策完成 App Store 隐私问卷，不能
把“不上传诊断日志”当成“第三方服务不收集任何数据”。

## 分发准备

模拟器构建不需要 Apple 证书，但不能交给 iPhone 用户安装。建议先通过 TestFlight 完成真机测试，
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
