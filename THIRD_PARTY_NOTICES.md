# 第三方来源与许可

- macOS/Linux 伪终端使用 `github.com/creack/pty v1.1.24`，MIT，Copyright (c) 2011 Keith Rarick。
- Windows ConPTY 使用 `github.com/UserExistsError/conpty v0.1.4`，MIT，Copyright (c) 2020 UserExistsError。
- Windows 命名管道使用 `github.com/Microsoft/go-winio v0.6.2`，MIT，版权归 Microsoft Corporation。
- 命令行 `pair` 在终端里画二维码使用 `rsc.io/qr v0.2.0`，BSD-3-Clause，Copyright (c) 2009 The Go Authors。

- 基础适配器来自 https://github.com/fuergaosi233/claude-codex ，MIT，Copyright (c) 2026 fuergaosi233。原始许可证保留在 LICENSE。
- SSH 通用代码来自 Tyrs Hand，MIT，Copyright (c) 2026 tyrs-hand contributors。源文件保留署名。
- Pi 来自 https://github.com/earendil-works/pi ，MIT，Copyright (c) 2025 Mario Zechner；由用户自行安装，不随适配器分发。适配器携带的 Pi 插件（计划模式、子代理、界面组件）及其依赖包按随包许可证分发。
- Claude Agent SDK 使用 Anthropic 自有条款，见 https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/LICENSE.md 。Claude Code 由用户安装官方版本，条款见 https://code.claude.com/docs/en/legal-and-compliance 。本项目的 MIT 许可不授予这些组件的额外权利。
- Codex 协议契约由 OpenAI Codex 0.157.1 生成，来源 https://github.com/openai/codex 。保留 protocol/LICENSE.codex 和 protocol/NOTICE.codex；上游代码采用 Apache-2.0。协议扩展和修订与生成的上游材料分开存放。

桌面客户端（Litch 的应用）里打进了这些第三方代码，许可文本随应用分发（应用资源目录下的 `licenses/`，每个包一个文件，打包时从装着的包里原样收集，见 `apps/desktop/scripts/licenses.mjs`）：

- 界面框架 `react`、`react-dom`、`scheduler`，MIT，Copyright (c) Meta Platforms, Inc. and affiliates。
- 终端控件 `@xterm/xterm` 及其插件 `@xterm/addon-fit`、`@xterm/addon-unicode11`、`@xterm/addon-web-links`，MIT，Copyright (c) The xterm.js authors、SourceLair Private Company、Christopher Jeffrey。
- 代码高亮 `highlight.js`，BSD-3-Clause，Copyright (c) 2006 Ivan Sagalaev。
- Markdown 解析 `marked`，MIT，Copyright (c) MarkedJS、Christopher Jeffrey。
- WebSocket `ws`，MIT，Copyright (c) Einar Otto Stangvik、Arnout Kazemier、Luigi Pinca 及贡献者。
- 二维码生成 `uqr`（扫码绑定手机的出码对话框用），MIT，Copyright (c) Project Nayuki、Anthony Fu。
- 字体 IBM Plex Mono、JetBrains Mono、Literata、Sometype Mono，SIL Open Font License 1.1，版权分别归 IBM Corp.、The JetBrains Mono Project Authors、The Literata Project Authors、The Sometype Mono Project Authors；经 `@fontsource/*` 的包取得。
- 外壳是 Electron，MIT，Copyright (c) Electron contributors、GitHub Inc.；它带着的 Chromium、Node.js 等组件的许可在应用里的 `LICENSES.chromium.html`。
- 应用图标和品牌标志是本项目自己的（`apps/desktop/assets/brand/`）。

运行包保留 node_modules 内的许可证。源码仓库不提交 node_modules、引擎二进制或用户凭据。
