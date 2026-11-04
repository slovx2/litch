# Mac 容量故障的本地检查兜底

仅替代 GitHub 托管 Mac **没有获得 runner** 的检查。不是跳过测试，也不是本地签名发版。`LITCH_CI_RECOVERY_ENABLED` 不参与此功能。

## 首次配置（维护者操作）

本仓库由 `slovx2` 一人维护，直接推送 main 和 release/x.y.z。规则只禁止 force push 和删除，不要求 PR、状态检查或审阅。环境审批人只设本人，**允许本人批准，但禁止管理员绕过审批**。默认就在当前 macOS 用户下执行隔离 HOME 测试；专用测试账号只是可选建议。隔离 HOME 不是 OS 沙箱，运行前仍须本人确认源码可信。

GitHub [上下文定义](https://docs.github.com/en/actions/reference/workflows-and-actions/contexts#github-context)规定：匹配 ref 配有 branch protection 或 ruleset 时 `github.ref_protected=true`，不要求同时开启 PR/状态检查；[Branches API](https://docs.github.com/en/rest/branches/branches#list-branches) 的 protected 也包括 rulesets。因此下面仅含两条规则的 active ruleset 满足现有门禁判断。尚未在本仓库实际配置及运行验证，不把文档定义当成实测。

### 请用户做的清单（按顺序）

**1. 准备 gh 权限。** GitHub → 头像 → Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token：Resource owner 选 `slovx2`，Only select repositories 选 `litch`。日常兜底需要 **Actions: Read and write、Checks: Read-only、Contents: Read-only、Variables: Read-only**，Metadata 随选仓库自动授予。首次执行下面的远端配置还需 **Administration: Read and write、Variables: Read and write**；配置后可去掉 Administration，并把 Variables 降回只读。使用本人身份在终端运行 `gh auth login --hostname github.com --git-protocol https`，交互输入令牌；不要把令牌写进命令、文档或聊天。已有登录态足够时无需重新登录。规则集和环境管理的权限要求见 [Rules API](https://docs.github.com/en/rest/repos/rules#create-a-repository-ruleset) 与 [Environments API](https://docs.github.com/en/rest/deployments/environments#create-or-update-an-environment)。

**2. 建最小规则集。** 以下只限制强推与删除，没有 PR、审阅、状态检查、创建限制或普通更新限制；`bypass_actors=[]` 使规则也约束管理员。仅首次创建时执行一次：

```sh
gh api --method POST repos/slovx2/litch/rulesets --input - <<'JSON'
{
  "name": "local-mac-protected-refs",
  "target": "branch",
  "enforcement": "active",
  "bypass_actors": [],
  "conditions": {
    "ref_name": {
      "include": ["refs/heads/main", "refs/heads/release/*"],
      "exclude": []
    }
  },
  "rules": [{"type": "non_fast_forward"}, {"type": "deletion"}]
}
JSON
```

**3. 建环境并指定本人审批。** `slovx2` 的用户 ID 是 `2713715`。先建环境，再加两个 branch（不是 tag）模式：

```sh
gh api --method PUT repos/slovx2/litch/environments/local-mac-fallback --input - <<'JSON'
{
  "wait_timer": 0,
  "prevent_self_review": false,
  "reviewers": [{"type": "User", "id": 2713715}],
  "deployment_branch_policy": {
    "protected_branches": false,
    "custom_branch_policies": true
  }
}
JSON
gh api --method POST repos/slovx2/litch/environments/local-mac-fallback/deployment-branch-policies -f name=main -f type=branch
gh api --method POST repos/slovx2/litch/environments/local-mac-fallback/deployment-branch-policies -f 'name=release/*' -f type=branch
```

随后打开 [Litch 环境设置](https://github.com/slovx2/litch/settings/environments) → `local-mac-fallback` → Deployment protection rules：Required reviewers 只留 `slovx2`；**不勾选 Prevent self-review**；**取消勾选 Allow administrators to bypass configured protection rules**；点击 **Save protection rules**。禁止绕过采用 GitHub [官方网页步骤](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments)，不依赖 REST 文档未列出的参数。Deployment branches and tags 应为 Selected branches and tags，只有 main 和 release/* 两条 branch 规则。接收工作流仍另查 `github.ref_protected` 与分支名称。

**4. 配置本机密钥路径和工具链。** 私钥已在此 Mac 生成，文件 `~/.config/litch-local-mac/signing-key.pem` 为 Ed25519 PKCS#8 PEM、权限 600，父目录权限 700；公钥为同目录 `signing-key.pub.pem`。私钥不进仓库、不打印、不上传、不传给受测子进程。执行：

```sh
export LITCH_LOCAL_MAC_SIGNING_KEY="$HOME/.config/litch-local-mac/signing-key.pem"
export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
node --version
go version
ruby -e 'puts RUBY_VERSION'
xcodebuild -version
xcrun --sdk iphonesimulator --show-sdk-version
```

Node 必须为 **24.21.0**、Go **1.26.10**、iOS 原生构建用 Ruby **3.4.7**，并需 Xcode 模拟器 SDK。版本不符时先由本人准备匹配工具链；脚本不升级全局环境。CocoaPods **1.16.2** 装在隔离 HOME。需要长期生效时，将第一条 export 手动加入 `~/.zshrc`；本次没有修改 shell 配置。

**5. 设置仓库公钥变量。** 完成前面环境审批限制后再执行；仅以下公钥可以公开：

```sh
gh variable set LITCH_LOCAL_MAC_PUBLIC_KEY --repo slovx2/litch <<'PEM'
-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAS7Il3YAUoMzX3pUBE51kG04h0d89MNLS/H5jg43Sxpk=
-----END PUBLIC KEY-----
PEM
```

**6. 只读核查配置。** 下面不触发 Full 或发版；应看到 protected=true、两条规则、本人审批且 prevent_self_review=false、两个 branch 模式和同一份公钥。管理员不能绕过的勾选状态另在环境网页核对：

```sh
gh api repos/slovx2/litch/branches --paginate --jq '.[] | select(.name == "main" or (.name | startswith("release/"))) | {name,protected}'
gh api repos/slovx2/litch/rules/branches/main --jq '[.[].type]'
gh api repos/slovx2/litch/environments/local-mac-fallback --jq '{protection_rules,deployment_branch_policy}'
gh api repos/slovx2/litch/environments/local-mac-fallback/deployment-branch-policies --jq '.branch_policies | map({name,type})'
gh variable get LITCH_LOCAL_MAC_PUBLIC_KEY --repo slovx2/litch
```

本线只提供这些远端写入命令，没有执行。配置后首次接收工作流还需确认 `github.ref_protected` 的实际运行值，以及本人正常批准能放行、绕过不能放行。

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
