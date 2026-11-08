# 测试签名与系统确认

真实输入验收使用独立的 `Litch Background Input Probe`。固定 bundle ID、证书和路径，
可以避免因测试构建身份变化而重复授予 TCC 权限；不能保证 macOS 永久不再显示屏幕采集确认。
身份协议回归和 `handshake.mjs` 不采集、不发送输入，无需辅助功能或屏幕录制授权。

## 保留原有授权与截图

默认继续使用显式配置的 `LITCH_SIGN_IDENTITY`，沿用原有探针的签名方式。已有流程若使用
Developer ID，不因本次修复改换证书、重置授权或扩大用途；只签专用探针，不修改正式助手。
截图与预览保持不变：一次截图使用 ScreenCaptureKit 的 `SCScreenshotManager`，预览使用 `SCStream`。

优先固定 `.app` 的绝对路径，避免每个工作树各起一份新路径的探针。构建用
`LITCH_CU_PROBE_OUTPUT`，运行用 `LITCH_CU_PROBE_APP` 或各入口原有路径参数。
签名时使用能访问既有钥匙串的本地构建上下文；测试助手运行时仍使用独立 HOME/CODEX_HOME。

## 可选加固：测试专用证书（用户本人操作）

已有探针能正常运行时，不需要执行下面的证书步骤。仅在主动选择独立测试证书时设置
`LITCH_CU_SIGN_IDENTITY`；设置后身份无效会直接报错，不悄悄回退到原有签名。

1. 在“钥匙串访问”的“证书助理 → 创建证书”中创建名为 `Litch CU Probe Local` 的
   自签名代码签名证书，身份类型选自签名根、证书类型选代码签名。保留同一份证书和私钥，
   不要每轮重建证书。仅按钥匙串提示设置信任该证书用于代码签名，不放开所有应用访问私钥。
2. 用 `security find-identity -v -p codesigning` 查询该证书的 SHA-1，设置
   `LITCH_CU_SIGN_IDENTITY`。此可选模式拒绝 `-`、证书名称和正式 Developer ID 的指纹；
   不自动创建证书、不解锁钥匙串、不代填密码。若 codesign 首次请求访问该私钥，
   由用户确认请求来自 `/usr/bin/codesign`，再决定是否允许其后续使用。
3. 选一个跨工作树固定的专用输出路径，后续不更名、不搬动。例如将构建与运行路径同时设为：

   ```sh
   export LITCH_CU_PROBE_OUTPUT='/Volumes/workspace/tyrs-hand/.local/cu-probe/.artifacts/integration/Litch Background Input Probe.app'
   export LITCH_CU_PROBE_APP="$LITCH_CU_PROBE_OUTPUT"
   export LITCH_CU_SIGN_IDENTITY='<测试证书的 SHA-1>'
   node apps/computer-use/probes/integration/build.mjs
   node apps/computer-use/probes/integration/build-driver.mjs
   node apps/computer-use/probes/integration/handshake.mjs
   ```

   这是示例路径，首次运行才创建。`startup`、`remote`、`focus-check` 和 `handshake` 接受
   `LITCH_CU_PROBE_APP`；`check`、`cu-trial/run` 和 `save-panel` 继续显式传入该绝对路径。
   不要让两个工作线并发覆盖或运行这份应用。切换普通探针与 `--coexist` 模式也会重建。
4. 在“系统设置 → 隐私与安全性”中，为该路径的探针开启“辅助功能”和
   “屏幕与系统音频录制”。若列表中有旧路径或旧证书的同名探针，由用户核对后处理，
   不撤销或复用正式 `Litch Computer Use` 的授权。
5. 第一次真实采集若出现“直接访问屏幕和音频”等系统确认，由用户本人处理。
   `screenRecording: true` 只是 TCC 预检通过，不代表这个二次确认已经完成。
   确认后重新开始一轮验收；已经部分执行的批次不自动重放。

启用可选加固后，构建脚本把 designated requirement 固定为 bundle ID 和测试证书的叶证书指纹，
不依赖二进制 cdhash。重复运行时先比较源码、构建模式、工具链、证书、输出路径及产物哈希，
再验证现有代码签名；全部一致才复用，不再次编译或签名。产物或签名异常会报错或重建，
不会接受无效缓存。更换证书需重新授权，必须显式进行。

## 两次构建验收

使用原有签名或可选测试证书，确认既有系统授权和电脑空闲后：

```sh
LITCH_SIGN_IDENTITY=- node apps/computer-use/probes/background/build.mjs
node apps/computer-use/probes/integration/build.mjs --rebuild
codesign -d -r- "$LITCH_CU_PROBE_APP"
node --import tsx apps/computer-use/probes/integration/focus-check.mts /tmp/litch-cu-rebuild-1.json
node apps/computer-use/probes/integration/build.mjs --rebuild
codesign -d -r- "$LITCH_CU_PROBE_APP"
node --import tsx apps/computer-use/probes/integration/focus-check.mts /tmp/litch-cu-rebuild-2.json
node apps/computer-use/probes/integration/build.mjs
```

两轮必须使用同一证书、路径与自有夹具；两份 requirement 应相同，两轮批次必须各自完整成功。
最后一次构建应输出“复用未变更的测试探针”。系统弹窗、真实用户活动或锁屏都使该轮无效，
不能为了通过而代点、改安全闸、写 TCC 数据库、重置授权或改写 replayd 的确认记录。
SIP 状态单独记录；SIP 关闭时的结果不代表开启时的权限行为。

## 区分系统确认与身份失效

2026-11-08 的已有失败证据：12:17:07 探针的 TCC ScreenCapture 请求获准，
12:17:08 截图已生成，随后 replayd 调用 `SCAlert.userAcknowledgementAlertWithBundleID`，
审计记录的前台为 `com.apple.UserNotificationCenter`。批次第一次点击计数为 1，第二次
被安全闸拒绝。同路径 13:01 的复跑两次点击成功。该产物使用不含 cdhash 的 Developer ID
requirement；这些事实不支持把本次故障判作 ad-hoc 重建造成 TCC 失效。

因此本次可确认是采集确认链路；缺少当时弹窗文字，不能断言是首次提醒还是周期提醒。
固定测试身份用于避免另一类重建授权问题，不会消除 macOS 自己的再次确认。
本机 macOS 26.5.1 的 replayd 记录中，同 bundle ID 的多个工作树分别以文件 URL 为键，
`kScreenCapturePrivacyHintPolicy` 均为 2592000 秒（30 天），同路径可多次使用而不再次提醒。
因此固定路径与身份后，不应把每次复跑都当作需要重新授权；但不能承诺“一次授权永久不弹”。
这台机器 SIP 关闭，上述记录不代表 Apple 对所有 macOS 26 版本、重启场景的行为承诺。
再次出现采集确认时，仍需用户点系统的允许/继续允许，不能由测试代点。
如果同一身份、路径仍每轮提示，保留该轮 helper 日志、foreground.json、replayd 与 tccd
的时间窗口，按实际原因调查，不反复切换证书或清空系统授权。

## 正式产品的影响与可选方向

正式助手与探针共用 `Capture.swift` 的 `SCScreenshotManager.captureImage` 和
`PreviewStream.swift` 的 `SCStream`，都用 `SCShareableContent` 查询目标后自行创建过滤器。
没有使用旧的 `CGWindowListCreateImage`/`CGDisplayCreateImage`，也没有接入系统
`SCContentSharingPicker`。因此“改成 ScreenCaptureKit”不是本次修复：它已经在用。

根据同一采集路径，正式用户也存在首次或再次采集确认中断自动化的风险；这是产品需要解释和
处理的系统交互，不能宣称只影响开发探针。此结论来自源码路径，不代表已对正式助手强制触发过提示。
截图已返回也不证明系统确认结束；弹窗随后进入前台时，下一步输入仍会被安全闸拒绝。

可选方向需单独决定，本次不改采集 API：

- 保留直接采集，固定身份和路径，明确区分 TCC 权限与采集确认，在系统要求时请用户允许。
  本机的 30 天提醒记录是实现证据，不是所有 macOS 26 版本的频率保证；重启后的行为未验。
- 使用系统 `SCContentSharingPicker` 返回的过滤器，再调用截图或流 API。
  Apple 明确允许在该采集会话期间访问用户选定的内容，无需另取全屏权限；代价是用户必须选择
  窗口/应用/显示器，不能将其描述为无需交互的全桌面自动化替换。
- VNC 类产品可向 Apple 申请 Persistent Content Capture；普通测试证书不自动取得此能力。
  企业受管设备另有 `forceBypassScreenCaptureAlert` MDM 设置，不是面向普通用户的应用内开关。

参考：[Apple 对 designated requirement 的说明](https://developer.apple.com/documentation/technotes/tn3127-inside-code-signing-requirements)、
[Apple DTS 对 ad-hoc 重建授权问题的确认](https://developer.apple.com/forums/thread/819406)、
[屏幕与音频录制权限设置](https://support.apple.com/guide/mac-help/mchld6aa7d23/mac)。
Apple 的 [Persistent Content Capture](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.developer.persistent-content-capture)
需要单独申请，面向 VNC 用途；本地测试证书不能通过自行添加 entitlement 获得这一能力。
系统选窗的会话授权见 [WWDC23 隐私说明](https://developer.apple.com/videos/play/wwdc2023/10053/)，
同一过滤器可用于截图见 [WWDC23 ScreenCaptureKit](https://developer.apple.com/videos/play/wwdc2023/10136/)。
旧 API 的提醒说明见 [macOS 15 发布说明](https://developer.apple.com/documentation/macos-release-notes/macos-15-release-notes)，
企业设置见 [Apple MDM Restrictions](https://developer.apple.com/documentation/devicemanagement/restrictions)。
