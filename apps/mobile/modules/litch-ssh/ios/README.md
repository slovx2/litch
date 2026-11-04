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
