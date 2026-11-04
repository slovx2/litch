# Mac 容量故障的本地检查兜底

仅替代 GitHub 托管 Mac **没有获得 runner** 的检查。不是跳过测试，也不是本地签名发版。`LITCH_CI_RECOVERY_ENABLED` 不参与此功能。

## 首次配置（维护者操作）

1. 保护 `main` 和用于发版的 `release/x.y.z` 分支，审阅修改工作流、检查脚本和依赖的提交。禁止来自 fork 和 PR 的本地兜底。
2. 创建 `local-mac-fallback` environment，配置 required reviewers、禁止本人批准、禁止绕过审批，deployment branches 只允许上述受保护分支。接收工作流仅支持 workflow_dispatch，并检查 `github.ref_protected`。环境必须先配置好，不能依赖 GitHub 自动创建一个无保护的同名环境。
3. 在可信 Mac 的专用测试用户下准备 Xcode（含模拟器 SDK）、Node **24.21.0**、Go **1.26.10**、Ruby **3.4.7** 和 `gh`。CocoaPods **1.16.2** 由脚本装到隔离 HOME，托管机通过固定提交的 ruby/setup-ruby 准备同版本 Ruby。使用单独测试账号更安全：隔离 HOME 不是操作系统沙箱，受测代码仍拥有当前用户的文件权限。
4. 维护者生成独立 **Ed25519 PEM** 证明签名密钥，权限设为仅本人读写；它不应是 Apple 证书或 SSH 登录私钥。私钥只留可信本机，环境变量 `LITCH_LOCAL_MAC_SIGNING_KEY` 指向其绝对路径。把 PEM 公钥放在仓库 Actions variable `LITCH_LOCAL_MAC_PUBLIC_KEY`（不是 environment-only variable，路由也需要它）。不把私钥上传 GitHub，不传给测试子进程。
5. `gh` 登录凭据需要读取 Actions/Checks/Contents、读取仓库 Actions variable，以及 dispatch 接收工作流的 Actions write。登录与密钥准备由本人完成，不输出令牌。

未设置公钥时，CI 保持托管 Mac 路径。无需注册 self-hosted runner，无需在本机放 Apple 签名或公证凭据。

## 执行

原 run 完全结束后，在包含这套脚本的仓库里运行（确保 PATH 中的 node/npm 是 24.21.0）：

```sh
node scripts/ci/local-mac-fallback.mjs --run 123456789 --dry-run
node scripts/ci/local-mac-fallback.mjs --run 123456789
```

`--dry-run` 只核查 GitHub 的来源、容量标注和请求清单，不运行测试、不上传。第二条命令获取该 SHA 的独立源码副本，使用隔离 HOME/状态/缓存执行与托管机相同的准备与完整检查，全部通过才签名并提交到 `Accept local Mac proof`。正常退出或命令报错都会删除本次副本与测试状态。系统强制杀死/断电时应由维护者检查 `.artifacts/local-mac-*` 残留；不要复用它。

接收工作流在 Linux 上等待 environment 审批；获准后再验签、读原始容量证据并上传不可变 artifact。随后按脚本输出的命令，**重跑原 run 的 `native / route`（独立 CI 为 `browser / route`）及其下游**。不要仅重跑 `checks`：它沿用旧路由，还会申请托管 Mac。不要重新派发 Prepare 或重跑整轮：成功出包与签名 job 应保留。GitHub 的 [job rerun API](https://docs.github.com/en/rest/actions/workflow-runs#re-run-a-job-from-a-workflow-run) 会重跑指定 job 及其依赖者；这条跨 reusable workflow 的实际接线仍需上线验收。

新 attempt 的 Mac 路由核验收据后，将 `checks` 安排到 Ubuntu，仅核验和导入本地证明；Gate/Full 仍读取当前 run 的成功 job 与带 SHA256 的 artifact。证明内保留原签名载荷、原 run/attempt/job 和收据 artifact ID/digest。产品包仍来自原 Prepare 的同 SHA 成功产物；公证 Accepted、staple、封存、人工公开和 Homebrew 规则不变。

## 拒绝条件与边界

- 必须同时有 `runner_id=0`、空 runner 名称、`steps=[]`、失败/取消结论，以及 GitHub Actions 的精确 `not acquired by Runner` failure 标注。只有 notice、人工取消、网络错误、产品断言失败或未知原因均不适用。
- 每次都读取该 run 全部 attempts 的合并 Mac job。任何一次真实执行失败都拒绝，不能用后来的容量失败洗掉前面的产品失败。其他平台失败仍由原门禁阻断。
- 签名证明绑定仓库、工作流 SHA、源码 SHA、原 run/attempt/job、完整命令集合、每项退出码、CLI 精确版本，以及 Node/Go/OS/Xcode/SDK 指纹；同 run 不同 SHA、集合缺漏和非全绿均拒绝。签名证明依赖可信签名者，没有声称能防御其主动造假或私钥被盗。
- 为确保接收工作流也运行同 SHA，来源分支上传时不得已前移；Full 的自定义源码 SHA 与工作流 SHA 不同时不能用此兜底。仅给一个 SHA 不能证明容量故障，因此入口要求 `--run`。
- 旧版 workflow 没有 `mac-native-request` 清单，不能追认历史旧版本的检查。分支前移后也不能随便换到最新脚本运行原候选。
- 本机离线、接收审批未通过、证明过期或 API 不可读时保持阻断，可等托管容量恢复。没有自动重试或自动公开。
- Mac 签名出包 job 的容量失败不由检查证明覆盖；仍须托管签名机恢复。Mac 适配器、浏览器、CU、窗口/引擎检查与 iOS 构建现在共用原生检查入口，因此可以按完整同源集合兜底。

## iOS 门禁与未来发布位置

Android 目前保留手机 JS 单测、类型、Markdown 测试和 APK 构建/正式签名验证；模拟器/Maestro 只有 Full 手动显式开启，候选不要求它。iOS 同样不加入 E2E 门禁：CI 与 Gate 必跑手机单测/类型，原生模块齐备后执行 `expo prebuild --platform ios`、CocoaPods 和无签名 Release 模拟器构建；若移动包提供 `test:ios`，同时运行该原生单测入口。通用手机单测一直必跑。

当前主线的本地模块仅声明 Android，证明明确记录 `ios.ready=false`，只延后 iOS 构建，不跳过手机单测/类型。乙线合入时，所有 `apps/mobile/modules/litch-*` 的 Expo 配置须声明 `apple` 或 `ios`，并提供各自 `ios/*.podspec`；部分合入、已有 iOS 源码却未声明平台或缺 podspec 都失败。默认 Expo workspace/scheme 为 `Litch`。这些是与原生线的集成契约，需要合并前核对。

未来在 `release.yml` 的正式出包层加入独立 iOS archive/upload job，并在 `release-provenance.mjs` / candidate manifest 中登记 IPA；不要把模拟器 `.app` 当作可晋级产物。此次不建占位的假成功上传 job，不生成或上传 IPA。启用 TestFlight/App Store 前还需 Apple Developer 团队、最终 bundle identifier、App Store Connect 应用记录及发行权限、发行证书私钥和 provisioning profile（或批准的自动签名配置）、App Store Connect API key/issuer/key ID，以及上传审批环境。凭据不经过聊天或源码。
