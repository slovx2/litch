# Contributing

Thanks for helping improve Codex Harness Adapter. This root guide is the GitHub
entry point; the full contributor guide lives in [docs/contributing.md](docs/contributing.md).

## Before you start

- 本机工具只要求最低稳定版本：Node.js 24（>= 24.0.0）、Go >= 1.26.6；Claude Code CLI >= 2.1.282、Pi CLI >= 0.99.1。允许更高稳定版，不要求用户安装精确版本或降级。
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

发版由维护者做。整个仓库只有一个版本号（根目录 `package.json`），适配器各包、客户端各包和它们的锁文件一起改，`npm run check` 会指出落下的；更新日志里“未发布”那一节改成版本号。打标签之前在本机跑 `npm run check:adapter-package`（要 Docker），并在要打标签的提交上跑一轮全量（`gh workflow run full.yml`）；release.yml 查不到这个提交上有通过的全量，就不挂发布页。推 `v<版本>` 标签后，`.github/workflows/release.yml` 出全部的包：适配器的独立发布包和安装脚本、macOS 的 dmg、Windows 的安装程序，都出好了一起挂到草稿发布页。核对过再公开，**不要标成预发布**：安装脚本取的是“最新一版”。

macOS 的 dmg 要用 Developer ID 签名并经苹果公证，公证用 App Store Connect 的 API 密钥（.p8）。要在仓库的 Settings → Secrets and variables → Actions 里配这五项机密（也可以用 `gh secret set <名字> --repo slovx2/litch`，值从标准输入给）：

| 名字 | 内容 | 怎么来 |
|---|---|---|
| `MACOS_CERTIFICATE_P12` | “Developer ID Application”证书连同私钥导出的 .p12，base64 编码 | 证书装在 Mac 的登录钥匙串里（没有的话在 Apple 开发者网站的 Certificates 里新建一张，只有账号持有人能建）。在“钥匙串访问”的“我的证书”里只选这一张（能展开看到私钥），右键导出成 .p12 并设一个密码，再 `base64 -i 证书.p12` 得到这一项 |
| `MACOS_CERTIFICATE_PASSWORD` | 导出 .p12 时设的密码，不能是空的 | |
| `APPLE_API_KEY` | API 密钥 .p8 文件的内容，原文或者 base64 都行 | App Store Connect → 用户和访问 → 集成 → App Store Connect API，新建一把团队密钥（权限选“开发者”就够），.p8 只能下载一次 |
| `APPLE_API_KEY_ID` | 这把密钥的编号 | 同一页的“密钥 ID” |
| `APPLE_API_ISSUER` | 签发者编号 | 同一页上方的 Issuer ID |

配好之后可以先在 Actions 里手动跑一次 Release、标签不填：照选的分支出包，不挂发布页，看 macOS 那一步签名、公证、起应用都过了再打标签。没配这几项时试跑出的是只有临时签名的 dmg，要挂到发布页时直接失败。Windows 的安装程序不签名，打开时系统会提示来源不明。

本机也能出安装包：`npm run client:pack` 之后 `npm run client:installer`，在 `apps/desktop/out/installer/` 下。macOS 上给了 `LITCH_SIGN_IDENTITY`（证书的名字）和 `LITCH_NOTARY_PROFILE`（`xcrun notarytool store-credentials` 存在钥匙串里的配置名）就签名并公证，见 `apps/desktop/scripts/make-installer.mjs` 开头；Windows 上要装 Inno Setup 6.7.1。
