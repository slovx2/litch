# Mac 容量不足时的本地检查

2026-11-05 用户定：单人维护，门禁可手动绕过，靠自觉。

默认 CI、Gate 和 Full 仍用托管 runner。Mac 检查排不到机器时，维护者在可信的候选 SHA 上本地执行相同检查，确认通过后手动绕过检查门禁。不配置签名密钥、公钥变量、接收工作流或审批环境，不上传本地证明，不自动重跑或接管托管 job。

## 本地执行

在 Apple Silicon Mac 的候选源码目录执行，先确认 HEAD 是要发布的完整 SHA、工作区干净。需要 Node 24.21.0、Go（允许按 go.mod 下载工具链）、Xcode/命令行工具；各引擎 CLI 由准备脚本按 protocol/versions.json 安装到仓库的 .artifacts，不安装或升级个人 harness。

```sh
git rev-parse HEAD
git status --short
export PATH=/opt/homebrew/opt/node@24/bin:/usr/local/go/bin:/opt/homebrew/bin:/usr/local/bin:$PATH
export NATIVE_DOMAINS='["browser","computer-use","client","client-engines","adapters"]'
node scripts/ci/prepare-mac-native.mjs
```

准备脚本安装精确依赖、构建所需包、准备隔离 CLI 和 Chrome，最后直接调用现有的 `scripts/ci/run-mac-native.mjs`。检查以隔离 HOME 和 harness 数据目录执行，窗口保持隐藏，退出码非零表示未通过；本地不生成检查证明文件。根 Go 与手机 Go 各按自己的 go.mod 选择版本。

依赖与构建已就绪时也可直接运行：

```sh
# client-engines/adapters 需要 CHA_CLAUDE_CLI、CHA_DSH_CLI 指向隔离安装；
# client 需要 LITCH_CHROME_BINARY 指向准备好的隔离 Chrome。
node scripts/ci/run-mac-native.mjs
```

本地串行执行一轮，核对逐项 MAC_CHECK_RESULT 和退出码。记录候选 SHA、检查范围和结果，写入下面的绕过原因。这里只替代检查；Mac 签名出包本身没有 runner 时仍只能等待或重跑。

## 手动绕过

Prepare 的 `release.yml` 增加两个输入：`bypass-gate` 默认 false；设为 true 时 `bypass-reason` 必须非空。示例中的 ref 必须仍指向已在本地验证的 SHA：

```sh
gh workflow run release.yml --ref release/0.33.0 \
  -f bypass-gate=true \
  -f bypass-reason='Mac 无可用 runner；已在本地验证候选完整 SHA，Mac 检查全部通过'
```

此模式跳过 Gate 和夜间检查判定，封存记录为 `bypassed`，不伪造成功的 Gate/Full 结果。操作者、时间、原因和候选 SHA 写入 candidate.json、封存及晋级 Actions Summary；candidate.json 随发布资产保留。Promote 继续使用原来的 source-run/attempt、artifact-id/digest、candidate-sha 和 tag，不增加第二次绕过开关。

五类出包仍须全部成功；macOS 签名、公证、票据和包验收、Android 正式签名、每份产物的 SHA 与摘要核验均不绕过。已封存成功的候选继续 Promote，不重新 Prepare。若旧 Prepare 卡在检查阶段，可取消旧 run 后在同一 ref 重新 Prepare 并填写绕过原因；不要同时运行两轮发布。

## iOS

普通 CI 保留手机类型检查、JS/Markdown 单测及手机 Go 测试。iOS 原生模拟器构建和原生单测仅在 Full 的 mobile 领域执行，不进入普通 CI 或发版 Gate；Ruby 3.4.7、固定 setup-ruby 和按 mobile/go.mod 准备工具链的规则保留。没有 TestFlight/App Store 上传。
