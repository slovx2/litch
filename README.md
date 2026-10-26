<p align="center">
  <img src="docs/images/litch-logo.png" width="420" alt="Litch">
</p>

# Litch

**简体中文** | [English](README.en.md)

Litch 致力于打造舒适的桌面客户端 + 远程连接体验。

- SSH 直连
- 移动端（安卓）SSH 直连远程设备，桌面端不开也能用
- 内置浏览器 + Computer Use（macOS、Windows）
- 当桌面连接时，远程设备可使用桌面浏览器和 Computer Use 功能，经你点头后还能在这台电脑上跑命令、读写文件
- 会话树（跨 harness 派子会话、回报与唤醒）和定时任务（设备上按时跑，桌面端关着也照跑）
- 扫码把桌面端已经配好的远程设备绑到手机上，不用在手机上配 SSH 钥匙

<p><img src="docs/images/zh/retro-dark-chat.png" width="100%" alt="复古皮肤，深色：对话"></p>

## 界面

### 极客复古（默认）

<p><img src="docs/images/zh/retro-dark-activity.png" width="100%" alt="复古皮肤，深色：展开活动区看改动"></p>
<p><img src="docs/images/zh/retro-light-stream.png" width="100%" alt="复古皮肤，浅色：正在输出"></p>

### 文艺人文

<details>
<summary>展开看文艺人文皮肤</summary>

<p><img src="docs/images/zh/human-light-chat.png" width="100%" alt="文艺皮肤，浅色：对话"></p>
<p><img src="docs/images/zh/human-light-activity.png" width="100%" alt="文艺皮肤，浅色：展开活动区看改动"></p>
<p><img src="docs/images/zh/human-dark-stream.png" width="100%" alt="文艺皮肤，深色：正在输出"></p>

</details>

截图里是演示数据。皮肤、明暗、语言（中文 / English）都可以随时切换。

## 特性

- **远程连接。** 经你自己的 ssh 配置和密钥连过去，两边都不开端口；断线自己重连，回合不丢。
- **多种 harness。** Claude Code、Pi、Codex，以及实验性的 DeepSeek Harness（DSH）、OpenCode 和 ACP agent（Gemini CLI、Qwen Code 等），收在同一个窗口里。
- **内置浏览器。** 你和代理共用；远端的 localhost 自动经 ssh 转发过来。
- **Computer Use（macOS、Windows）。** 代理操作这台电脑上的任意应用，不逐个批准；操作时屏幕上有提示，按 Esc 就停。
- **操作这台电脑。** 远程设备上的代理经你点头后在桌面这台电脑上跑命令、读写文件、在两台机器之间复制文件；默认关，按设备打开。
- **会话树。** 会话可以派出子会话，而且跨 harness：Claude Code 的会话能派 Codex、Pi 等的子会话，反过来也行；子会话挂在父会话下面；结束时回报给父会话，必要时把它唤醒接着做。
- **定时任务。** 任务存在设备上、由设备按时执行，桌面端关着、断开了也照跑；每次新建会话或在已有会话里接着发。
- **扫码绑定手机。** 桌面端（或那台机器上的 `litch pair`）出二维码，手机扫码后生成自己的钥匙、登记到那台机器上，你在电脑上核对确认码点允许；电脑的钥匙不离开电脑，每部手机能单独撤销。
- **写代码的面板。** 终端（断线不丢）、文件树、差异审阅。
- **移动端（安卓）。** 经 SSH 直连远程设备，不经过桌面端、没有中转服务：看会话、发消息、审批、开终端、管定时任务；扫码就能绑定桌面端配好的设备。

## 当前状态

| 部分 | 状态 |
|---|---|
| 适配器 `codex-harness-adapter` | 可用。让 Codex 桌面端直接驱动 Claude Code、Pi 和实验性的 DSH、OpenCode、ACP agent；Litch 也经它连一台机器上的全部 harness。见[安装与使用](ADAPTER.md) |
| 桌面客户端 Litch | 可用，macOS 和 Windows 都已验证可稳定使用。有 macOS（Apple Silicon）和 Windows 的安装包（见下面“下载”，Windows 版有几项还不能用），也可以从源码运行。应用自带一份适配器，打开就把本机上装了的 harness 收在“本机”这台设备下。能浏览会话，发消息（可带图片和附件），排队、打断与引导，回答审批和提问，用计划模式、`/` 命令和 `@` 找文件；新建会话时选设备、项目和 harness，同一个目录下各 harness 的会话归在同一个项目；侧面板里有终端、文件和差异审阅；设备页里可以启用、停用一个 harness，改它的设置，看诊断和日志。也能经 SSH 连远程机器上的设备服务或原生 codex |
| 内置浏览器、Computer Use | 0.8.0 起提供；Computer Use 0.8.0 起有 macOS 版，0.10.0 起有 Windows 版。远程设备上的代理也能用桌面这两项能力（那台机器上的适配器要 0.8.0 或更新） |
| 操作这台电脑 | 0.10.0 起提供，桌面端目前只支持 macOS。远程设备上的会话经你点头后操作桌面这台电脑的命令和文件；Codex、Claude Code、Pi 的会话直接用工具，其余 harness 用那台机器上的 `litch-machine` 命令（那台机器上的适配器要 0.10.0 或更新） |
| 安卓客户端 | 0.9.0 起提供，已验证可稳定使用。经 SSH 连装了适配器的远程机器：看会话、发消息、审批、开终端；0.11.0 起能管定时任务 |
| 会话树 | 0.11.0 起提供。模型经 `litch_sessions` 派子会话、读写自己的子会话，也能在界面上手动派；Codex、Claude Code、Pi、dsh、OpenCode 的会话能用，ACP agent 的会话不能派但能当子会话（那台机器上的适配器要 0.11.0 或更新） |
| 定时任务 | 0.11.0 起提供。日程按设备的时区算，模型也能经 `litch_tasks` 建任务；桌面端和安卓客户端都能管（那台机器上的适配器要 0.11.0 或更新） |
| 扫码绑定手机 | 0.12.0 起提供。安卓客户端扫码添加；出码时可以改给手机用的地址（手机要能直连，不支持经跳板机）；本机要先打开系统的 SSH 服务（macOS 的“远程登录”）。那台机器上的适配器要 0.12.0 或更新；远程设备是 Windows 时未经完整测试 |

## 下载

从[发布页](https://github.com/slovx2/litch/releases/latest)下载：

| 系统 | 文件 | 说明 |
|---|---|---|
| macOS（Apple Silicon） | `Litch-<版本>-macos-arm64.dmg` | 签过名，经过苹果公证。打开后把 Litch 拖进“应用程序” |
| Windows（x64） | `Litch-<版本>-windows-x64-setup.exe` | 已在 Windows 11 上验证可稳定使用（终端用的是 Windows PowerShell）；**操作这台电脑在 Windows 上还不能用**，Windows 的管理员账号还不能扫码绑定手机。安装程序没有签名，Windows 会提示来源不明，点“更多信息”再点“仍要运行”。只装给当前用户，不要管理员权限 |
| 安卓（arm64，Android 7.0 及以上） | `Litch-<版本>-android-arm64.apk` | 直接安装，第一次系统会让你允许“安装未知应用”。应用自己生成一把 SSH 钥匙，把它的公钥加到远程机器的 `authorized_keys` 里就能连 |

应用自带一份适配器，打开就把本机上装了的 Claude Code、Pi、DSH、OpenCode 和 codex 收在“本机”这台设备下；这些 harness 本身要另外装好并登录。Intel 芯片的 Mac 暂时没有安装包，可以从源码运行。

它还会把一个技能“Litch 产品手册”（`litch-manual`，源文件在 [`skills/litch-manual`](skills/litch-manual)）装进本机的 harness（放在 `~/.agents/skills`，并链到 `~/.claude/skills` 等处），Agent 能照着它讲解 Litch、用 `litch config` 命令改设置；不想要可以在设置里关掉。

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
