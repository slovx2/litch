<p align="center">
  <img src="docs/images/litch-logo.png" width="420" alt="Litch">
</p>

# Litch

**简体中文** | [English](README.en.md)

在一台桌面上，指挥每一台机器上的编码代理。

Litch 是开源的桌面客户端，把本机和远程机器上的 Claude Code、Pi、Codex 等 harness 收在一个窗口里，说的是 Codex app-server 协议。它重点做三件事：

- **远程连接。** 经你自己的 ssh 连任意多台机器，两边都不开端口；每台机器上的各种 harness 一起收进来，断线自己重连，回合不丢。
- **内置浏览器。** 代理可以在 Litch 自带的浏览器里打开网页、点击、填表、截图，你在侧面板里看着它做，随时接手。
- **Computer Use（macOS）。** 代理可以操作这台 Mac 上的应用，每个应用第一次操作前都要你点头。

**远程机器上的代理也用得上这台桌面的浏览器和 Computer Use。** 代理跑在服务器上，浏览器和桌面在你手边：远端的开发服务器（`localhost:3000` 这类地址）会自动经 ssh 转发到桌面的浏览器里打开。两项能力在每台设备的设置里单独开关（浏览器默认开，Computer Use 默认关）。

## 界面

### 极客复古（默认）

<p>
  <img src="docs/images/zh/retro-dark-chat.png" width="32%" alt="复古皮肤，深色：对话">
  <img src="docs/images/zh/retro-dark-activity.png" width="32%" alt="复古皮肤，深色：展开活动区看改动">
  <img src="docs/images/zh/retro-light-stream.png" width="32%" alt="复古皮肤，浅色：正在输出">
</p>

### 文艺人文

<p>
  <img src="docs/images/zh/human-light-chat.png" width="32%" alt="文艺皮肤，浅色：对话">
  <img src="docs/images/zh/human-light-activity.png" width="32%" alt="文艺皮肤，浅色：展开活动区看改动">
  <img src="docs/images/zh/human-dark-stream.png" width="32%" alt="文艺皮肤，深色：正在输出">
</p>

截图里是演示数据。皮肤、明暗、语言（中文 / English）都可以随时切换。

## 特性

- **连接远程机器。** 经系统的 ssh 连过去，两边都不开端口，登录交给你自己的 ssh 配置和密钥代理，应用里没有密码输入框。那台机器上装了适配器，就把它上面的多种 harness 一起收进来（设置、项目、断线不丢的终端都有）；只装了原生 codex 也能连，不用再装别的。断线自己重连，正在进行的回合不丢。连适配器这条路要求那台机器上的适配器是 0.6.0 或更新的版本；要让那台机器上的代理用桌面的浏览器和 Computer Use，适配器要 0.8.0 或更新。
- **内置浏览器。** 侧面板里的浏览器，你自己能用，代理也能用：打开网页、读页面、点击、填表、上传文件、截图。第一次访问一个外部网站要你同意（本回合、本会话、一直允许或拒绝），本机地址直接放行。对话里的链接点了默认在内置浏览器里开，按住 Cmd/Ctrl 点或在设置里关掉就交给系统浏览器。远程设备上的代理用的也是这个浏览器，远端的 localhost 自动经 ssh 转发过来。
- **Computer Use（只支持 macOS）。** 代理看屏幕、操作 Mac 上的应用。系统权限授给一个单独签名的小助手“Litch Computer Use”，不授给 Litch 本身：在设置页的 Computer Use 一组里点“打开系统设置”，列表里就会出现它，打开辅助功能和屏幕录制两个开关即可。每个应用第一次操作前要你批准，密码管理器这类应用一律不许碰；操作时屏幕上有提示，按 Esc 就停。远程设备上的代理也能用，但要在那台设备的设置里单独打开，而且每个会话都要重新批准。
- **多种 harness。** Claude Code、Pi、Codex（原生），以及实验性的 DeepSeek Harness（DSH）、OpenCode，和说 ACP 协议的 agent（Gemini CLI、Qwen Code，或者自己填命令接任意 ACP agent）。每个引擎继续用自己的会话、工具、模型配置和登录。机器上装了 codex，它的会话就自动和别的 harness 并排列出来。
- **写代码时用得上的面板。** 终端（断线不丢）、文件树和查看器、差异审阅（暂存、还原，行内批注随下一条消息发出去）。
- **移动端。** 开发中。

## 当前状态

| 部分 | 状态 |
|---|---|
| 适配器 `codex-harness-adapter` | 可用。让 Codex 桌面端直接驱动 Claude Code、Pi 和实验性的 DSH、OpenCode、ACP agent；Litch 也经它连一台机器上的全部 harness。见[安装与使用](ADAPTER.md) |
| 桌面客户端 Litch | 早期开发。有 macOS（Apple Silicon）和 Windows 的安装包（见下面“下载”，Windows 版未经过完整测试），也可以从源码运行。应用自带一份适配器，打开就把本机上装了的 harness 收在“本机”这台设备下。能浏览会话，发消息（可带图片和附件），排队、打断与引导，回答审批和提问，用计划模式、`/` 命令和 `@` 找文件；新建会话时选设备、项目和 harness，同一个目录下各 harness 的会话归在同一个项目；侧面板里有终端、文件和差异审阅；设备页里可以启用、停用一个 harness，改它的设置，看诊断和日志。也能经 SSH 连远程机器上的设备服务或原生 codex |
| 内置浏览器、Computer Use | 0.8.0 起提供，Computer Use 只在 macOS 上有。远程设备上的代理也能用桌面这两项能力（那台机器上的适配器要 0.8.0 或更新） |
| 移动端 | 开发中 |

## 下载

从[发布页](https://github.com/slovx2/litch/releases/latest)下载：

| 系统 | 文件 | 说明 |
|---|---|---|
| macOS（Apple Silicon） | `Litch-<版本>-macos-arm64.dmg` | 签过名，经过苹果公证。打开后把 Litch 拖进“应用程序” |
| Windows（x64） | `Litch-<版本>-windows-x64-setup.exe` | **未经过完整测试**，可能有用不了的地方。安装程序没有签名，Windows 会提示来源不明，点“更多信息”再点“仍要运行”。只装给当前用户，不要管理员权限 |

应用自带一份适配器，打开就把本机上装了的 Claude Code、Pi、DSH、OpenCode 和 codex 收在“本机”这台设备下；这些 harness 本身要另外装好并登录。Intel 芯片的 Mac 暂时没有安装包，可以从源码运行。

## 从源码运行

需要 Node.js 24。

```sh
git clone https://github.com/slovx2/litch.git
cd litch
npm run client:setup
npm run client:start:mock
```

这样看到的是演示数据。要看真实的会话，先按[适配器说明](ADAPTER.md)把适配器跑起来，再把它的套接字交给客户端：

```sh
LITCH_ENTRY=~/.codex-harness-adapter/pi/runtime.sock npm run client:start
```

`pi` 可以换成 `claude-code`；换成 `~/.codex-harness-adapter/device/device.sock` 就是一条连接里有全部 harness；也可以填原生 codex 用 `codex app-server --listen unix://<路径>` 监听的套接字。

在 macOS 上可以打成一个能直接打开的应用，放在 `apps/desktop/out` 下面。先跑过上面的 `npm run client:setup`；它自带一份适配器，所以还要把适配器构建出来（需要 Go）：

```sh
npm ci
npm ci --prefix packages/claude
npm ci --prefix packages/pi
npm ci --prefix packages/dsh
npm ci --prefix packages/opencode
npm ci --prefix packages/acp
npm run build
npm run client:pack
open apps/desktop/out/Litch-darwin-arm64/Litch.app
```

打开之后它会自己拉起那份适配器，本机上装了的 Claude Code、Pi、DSH、OpenCode 和 codex 出现在“本机”这台设备下（codex 用的是你自己的那份数据，默认在 `~/.codex`，不想要可以在设备页里停用）；没装的会写明原因，在设备页里可以填命令的路径或者停用。适配器的状态目录是 `~/.codex-harness-adapter`，和独立安装的适配器共用；退出应用后服务留着，会话不断。

自己打的这一份只做了本机的临时签名，换一台机器打开会被系统拦下；Computer Use 的系统权限也认签名，每重新打一次包就要重新授权。要给别人用、或者长期用 Computer Use，用发布页上的安装包。

## 文档

[适配器的安装与使用](ADAPTER.md) · [开发约定](AGENTS.md) · [参与开发](CONTRIBUTING.md)

---

适配器基于 [fuergaosi233/claude-codex](https://github.com/fuergaosi233/claude-codex)。[MIT](LICENSE) · [第三方许可](THIRD_PARTY_NOTICES.md)
