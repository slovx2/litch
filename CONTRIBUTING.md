# Contributing

Thanks for helping improve Codex Harness Adapter. This root guide is the GitHub
entry point; the full contributor guide lives in [docs/contributing.md](docs/contributing.md).

## Before you start

- 本机工具只要求最低稳定版本：Node.js 24（>= 24.0.0）、Go >= 1.26.10；Claude Code CLI >= 2.1.282、Pi CLI >= 0.99.1。允许更高稳定版，不要求用户安装精确版本或降级。
- SDK/插件的仓库依赖仍按精确版本锁定，CI 使用 `protocol/versions.json` 的基线复现；环境版本范围与依赖锁是不同约束。
- 使用 `npm run setup` 安装锁定依赖并构建，`npm start` 自动检测并启动可用引擎；缺失或失败入口只告警，`--harness` 可指定单引擎。
- Keep changes small and reviewable. Separate runtime/protocol work, docs work,
  dependency updates, and release planning into different pull requests.
- Do not commit secrets, local Claude Code session files, OAuth data, API keys,
  `.env` files, or acceptance-test transcripts.

## Development checks

Run the checks that match your change:

```bash
npm run typecheck
npm run check
npm test
npm run docs:build
```

For runtime or protocol changes, include focused tests under `test/` and run the
full `npm test` suite. For docs-only changes, run `npm run docs:build` and note
whether any link-checking gap remains.

## Project layout

- `packages/claude`、`packages/pi` 是并列的引擎适配器。
- `packages/shared` 提供共享协议、传输和版本检测。
- `cmd/codex-harness-adapter` 提供本机启动器，`sshserver` 提供通用 SSH 库。
- `scripts/codex-shim` is the remote `codex` PATH shim.
- `docs/` is the VitePress documentation site.
- 各适配器的 `test/` 包含针对其编译输出的 `node:test` 测试。

## Pull request expectations

- Keep each PR focused on one behavior or documentation topic.
- Include a clear test plan in the PR description.
- Add or update tests for code changes.
- Avoid broad formatting churn unless the PR is explicitly a formatting/tooling
  change.

See [docs/contributing.md](docs/contributing.md) for the detailed toolchain and
coding conventions.

## 发版

发版由维护者做。整个仓库只有一个版本号，根包、各包/锁、mobile app.json 和更新日志在冻结候选前一起同步，`npm run check` 会检查版本一致性。

标准流程见[候选准备与产物晋级](docs/reference/release-candidates.md)：先在候选分支运行 `release.yml`（Prepare），并行完成门禁与正式签名出包；随后用 `promote.yml` 指定 source run/attempt、候选 SHA、artifact ID 和 digest，只晋级已验文件。标签不再触发测试或打包。独立 Gate 仅用于诊断，不是标准发版的重复前置步骤。

Promote 默认只读 `verify`；`draft` 创建/回验草稿、不公开；取得本版人工授权并核对验收后，才显式选择 `publish` 并输入确认标签。公开前重查夜间、blocker、标签 SHA、资产和版本顺序，禁止覆盖已公开版本或让 Latest 倒退。Tap PR 输入自动生成，不自动发布 Homebrew。手机模拟器 E2E 按用户决定只在夜间/手动 Full；手机单测、类型及正式 APK 签名/manifest/版本验证仍是候选必需。


macOS 的 dmg 要用 Developer ID 签名并经苹果公证，公证用 App Store Connect 的 API 密钥（.p8）。要在仓库的 Settings → Secrets and variables → Actions 里配这五项机密（也可以用 `gh secret set <名字> --repo slovx2/litch`，值从标准输入给）：

| 名字 | 内容 | 怎么来 |
|---|---|---|
| `MACOS_CERTIFICATE_P12` | “Developer ID Application”证书连同私钥导出的 .p12，base64 编码 | 证书装在 Mac 的登录钥匙串里（没有的话在 Apple 开发者网站的 Certificates 里新建一张，只有账号持有人能建）。在“钥匙串访问”的“我的证书”里只选这一张（能展开看到私钥），右键导出成 .p12 并设一个密码，再 `base64 -i 证书.p12` 得到这一项 |
| `MACOS_CERTIFICATE_PASSWORD` | 导出 .p12 时设的密码，不能是空的 | |
| `APPLE_API_KEY` | API 密钥 .p8 文件的内容，原文或者 base64 都行 | App Store Connect → 用户和访问 → 集成 → App Store Connect API，新建一把团队密钥（权限选“开发者”就够），.p8 只能下载一次 |
| `APPLE_API_KEY_ID` | 这把密钥的编号 | 同一页的“密钥 ID” |
| `APPLE_API_ISSUER` | 签发者编号 | 同一页上方的 Issuer ID |

Prepare 不创建标签或发布页，但始终要求正式签名和公证凭据；缺少任何一项直接失败，不生成可晋级的临时签名候选。Windows 安装程序仍按现行政策不签名，打开时系统会提示来源不明。

安卓的 apk 要用发版钥匙签名：安卓只接受同一把钥匙签的更新，钥匙丢了就发不出能覆盖安装的新版本，务必另外备份。另配这三项机密：

| 名字 | 内容 |
|---|---|
| `ANDROID_KEYSTORE_P12` | 钥匙库（PKCS12）的 base64（`base64 -i 钥匙库.p12`） |
| `ANDROID_KEYSTORE_PASSWORD` | 钥匙库和钥匙的密码（PKCS12 里两者是同一个） |
| `ANDROID_KEY_ALIAS` | 钥匙的别名 |

release.yml 用 `apksigner` 核对签出来的包的证书指纹（写在 android 作业的 `RELEASE_CERT_SHA256` 里），对不上不发。本机签一个包：给出 `LITCH_ANDROID_KEYSTORE`（钥匙库路径）、`LITCH_ANDROID_KEYSTORE_PASSWORD`、`LITCH_ANDROID_KEY_ALIAS`、`LITCH_ANDROID_KEY_PASSWORD` 四个环境变量，再在 `apps/mobile` 下 `npx expo prebuild --platform android --clean --no-install && npm run android:release`；不给就用调试钥匙签。

本机也能出安装包：`npm run client:pack` 之后 `npm run client:installer`，在 `apps/desktop/out/installer/` 下。macOS 上给了 `LITCH_SIGN_IDENTITY`（证书的名字）和 `LITCH_NOTARY_PROFILE`（`xcrun notarytool store-credentials` 存在钥匙串里的配置名）就签名并公证，见 `apps/desktop/scripts/make-installer.mjs` 开头；Windows 上要装 Inno Setup 6.7.1。
