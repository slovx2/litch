# 测试签名与系统确认

真实输入验收使用独立的 `Litch Background Input Probe`。固定 bundle ID、证书和路径，
可以避免因测试构建身份变化而重复授予 TCC 权限；不能保证 macOS 永久不再显示屏幕采集确认。
身份协议回归和 `handshake.mjs` 不采集、不发送输入，无需辅助功能或屏幕录制授权。

## 一次性准备（用户本人操作）

1. 在“钥匙串访问”的“证书助理 → 创建证书”中创建名为 `Litch CU Probe Local` 的
   自签名代码签名证书，身份类型选自签名根、证书类型选代码签名。保留同一份证书和私钥，
   不要每轮重建证书。仅按钥匙串提示设置信任该证书用于代码签名，不放开所有应用访问私钥。
2. 用 `security find-identity -v -p codesigning` 查询该证书的 SHA-1，设置
   `LITCH_CU_SIGN_IDENTITY`。脚本拒绝 `-`、证书名称和正式 Developer ID 的指纹；
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

构建脚本把 designated requirement 固定为 bundle ID 和测试证书的叶证书指纹，
不依赖二进制 cdhash。重复运行时先比较源码、构建模式、工具链、证书、输出路径及产物哈希，
再验证现有代码签名；全部一致才复用，不再次编译或签名。产物或签名异常会报错或重建，
不会接受无效缓存。更换证书需重新授权，必须显式进行。

## 两次构建验收

首次证书与系统授权准备完毕、确认电脑空闲后：

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
如果同一身份、路径仍每轮提示，保留该轮 helper 日志、foreground.json、replayd 与 tccd
的时间窗口，按实际原因调查，不反复切换证书或清空系统授权。

参考：[Apple 对 designated requirement 的说明](https://developer.apple.com/documentation/technotes/tn3127-inside-code-signing-requirements)、
[Apple DTS 对 ad-hoc 重建授权问题的确认](https://developer.apple.com/forums/thread/819406)、
[屏幕与音频录制权限设置](https://support.apple.com/guide/mac-help/mchld6aa7d23/mac)。
Apple 的 [Persistent Content Capture](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.developer.persistent-content-capture)
需要单独申请，面向 VNC 用途；本地测试证书不能通过自行添加 entitlement 获得这一能力。
