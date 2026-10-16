# codex-harness-adapter

**简体中文** | [English](ADAPTER.en.md)

> 这是 [Litch](README.md) 仓库里的适配器，可以单独安装使用，不依赖 Litch 桌面客户端。

## 解决什么问题

**用成熟的 Codex 桌面 UI 控制 Claude Code、Pi 等 harness。** 在一个界面里管理项目、对话、文件修改和审批，继续使用各引擎自己的模型配置与登录。

目前支持 Claude Code、Pi，适用于 macOS、Linux、Windows；DeepSeek Harness 为实验性支持（[说明](docs/guide/configuration.md#deepseek-harness实验性)）。

## 安装与启动

### macOS：Homebrew（后台运行）

先安装并登录 Claude Code 或 Pi（至少一个）。Claude 需要本机独立安装的 `claude` 已登录（`claude auth status` 显示已登录）；Pi 需用 npm 安装（`npm install -g @earendil-works/pi-coding-agent`），适配器直接使用这份安装。然后：

```sh
brew install slovx2/tap/codex-harness-adapter
brew services start codex-harness-adapter
codex-harness-adapter ssh-config
```

服务登录后自动启动、异常退出自动重启，依赖 Homebrew 的 `node@24`。日志在 `$(brew --prefix)/var/log/codex-harness-adapter.log`，停止用 `brew services stop codex-harness-adapter`。目前只提供 Apple Silicon 预编译包。

### Linux：安装脚本

0.6.0 起提供。先安装并登录 Claude Code 或 Pi（至少一个，要求同上）。然后：

```sh
curl -fsSL https://github.com/slovx2/litch/releases/latest/download/install.sh | sh
~/.local/bin/codex-harness-adapter start
```

发布包自带 Node，机器上不用另装 Node 和 Go，也不要 root。支持 x64 和 arm64，需要 glibc；Alpine 这类 musl 的系统请从源码启动。程序装在 `~/.local/share/codex-harness-adapter/<版本>/`，命令是 `~/.local/bin/codex-harness-adapter`；这个目录不在 `PATH` 里时脚本会说明怎么办。

重跑同一条命令就是升级；`sh -s -- --version <版本>` 装指定的版本（也用来退回旧版本），`sh -s -- --uninstall` 卸载（状态目录 `~/.codex-harness-adapter` 不动）。离线时把压缩包和 `codex-harness-adapter-SHA256SUMS.txt` 拷到机器上，用 `sh install.sh --from <压缩包>`。升级后，已在运行的服务还是旧版本，脚本不替你停它，会给出换上新版的两条命令：`codex-harness-adapter device-stop --if-idle`（只在服务闲着时才停：有回合在跑、有终端开着、有客户端连着都不停，并说明是哪一种），再 `codex-harness-adapter device-start`。服务用的不是默认状态目录时两条都带上同一个 `--home`。去掉 `--if-idle` 会直接停掉它，进行中的回合会被打断。0.5.1 及更早的服务不认识这条命令，那一次要等回合结束后手工结束进程。

Claude Code 还需要 `bubblewrap`、`socat`。macOS（Apple Silicon）上不用 Homebrew 时也可以用这个脚本。

### 从源码启动

准备 Node.js **24**、Go **≥ 1.26.6**，以及至少一个已配置登录的引擎：[Claude Code **≥ 2.1.282**](https://code.claude.com/docs/en/setup) 或 [Pi **≥ 0.99.1**](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/README.md#getting-started)（npm 安装）。接受更高稳定版本，无需安装精确版本。[各系统依赖](docs/guide/getting-started.md#系统依赖)

```sh
git clone https://github.com/slovx2/litch.git
cd litch
npm run setup
npm start
```

自动检测并启动可用引擎；缺失或失败只告警，不影响其他入口。看到“SSH 就绪”后保持终端运行，Ctrl-C 停止。以后启动只需 `npm start`。

## Codex 桌面配置

1. **可选：设置别名。** 将启动输出的 `Host` 配置加入 `~/.ssh/config`（Windows：`%USERPROFILE%\.ssh\config`），可自行修改别名。
2. **添加连接。** Codex **设置 → 连接 → SSH → 添加**，选择别名或 **手动添加**。手动填写启动输出中的主机、端口、用户和私钥路径。
3. **添加项目。** 主界面 **添加项目 → 远程设备下拉菜单 → 刚添加的设备 → 选择项目目录**。

即使项目在本机，也要从该 SSH 设备入口添加。[详细连接指南](docs/guide/gui.md)

## 在远程机器上给 Litch 用

Litch 连远程机器只用那台机器自己的 SSH 服务（平时 `ssh 主机名` 能登录就行），不需要适配器开任何端口。在那台机器上装好适配器，回到 Litch 的“设备”一页添加这台主机即可：Litch 登录后自己把服务拉起来并让它常驻，一条连接里就是这台机器上全部的 harness，终端断线也不丢。

- 需要 0.6.0 或更新的版本（带设备服务，认识 `device-start` 子命令）；装的是旧版时 Litch 会提示“适配器太旧”。
- 不用先手工启动，也不用配 `ssh-config`（那是给 Codex 桌面端的）。Litch 拉起的服务默认不开那些 SSH 入口。
- 用的是默认状态目录 `~/.codex-harness-adapter`。
- 命令不在登录 shell 的 `PATH` 里也找得到，只要在 `~/.local/bin` 或 Homebrew 的目录里。
- 只有原生 codex 的机器也能连，只是只有 Codex 一个 harness。之后装上适配器，在设备详情里点“重新检查”就改连设备服务；设备服务找得到 codex 就会把它打开，原来的 Codex 会话照样看得到；找不到时在设置里填它的命令行路径。
- 提示“适配器太旧”：重跑安装脚本或 `brew upgrade codex-harness-adapter`。提示“有一份旧版的服务正在运行”：等回合结束后把它重启一次。Litch 不会替你停服务或升级。

## 工作原理、高级使用与排障

```text
Codex 桌面 → 本地 SSH → 适配器 → Claude Code / Pi
```

SSH 仅监听 `127.0.0.1`：Claude 默认 **7331**，Pi 默认 **7332**。两个引擎独立运行，不修改全局 Codex CLI。

```sh
# 单独启动引擎（claude-code 可换成 pi）
npm start -- --harness claude-code

# 修改两个入口的 SSH 端口
npm start -- --claude-port 7441 --pi-port 7442

# 单引擎自定义端口
npm start -- --harness pi --port 7442

# 检查指定引擎 / 查看 SSH 配置
npm run doctor -- --harness pi
npm run ssh-config -- --harness pi --port 7442
```

用 Homebrew 或安装脚本装的，上述 `npm start`、`npm run doctor`、`npm run ssh-config` 对应 `codex-harness-adapter start|doctor|ssh-config`，参数相同。

自定义端口每次启动都需传入，并同步更新桌面连接。`--home <目录>` 可更改状态目录，诊断和查看配置时也需传入。

适配器与引擎的环境变量（如 `CHA_CLAUDE_*`、`PI_CLI`、代理）写入 `~/.codex-harness-adapter/env`，每行 `KEY=VALUE`，前台和后台服务都会读取；修改后重启服务。

用 [Litch](README.md) 桌面端时，各 harness 的启用与停用、命令路径、环境变量，以及 SSH 入口的开关和端口，都可以在它的“设备”页里改。改动存在 `~/.codex-harness-adapter/device/settings.json`，优先于启动参数和环境文件：启动参数只是设置里没写过时的默认值，环境文件排在设置之后。Litch 自带的那份适配器和这里装的是同一个东西、共用同一个状态目录，它是用 `--ssh=off` 起的，不监听任何端口；一个 harness 都起不来时服务也留着，好让桌面端连上去看原因、改设置。机器上装了 Codex 命令行（0.157.1 及以上）的话，可以在设备页里把它也作为一个 harness 打开（默认关）：用的是你自己的 Codex 数据目录，同一个会话同一时间只能有一个 codex 进程在写。

命令行的输出有中文和英文两种，默认跟随系统语言；用 `CHA_LANG=zh-CN` 或 `CHA_LANG=en` 指定，也可以写进上面的环境文件。引擎经协议发到 Codex 界面里的提示目前只有中文。

- **启动失败：** 运行对应引擎的 `doctor`，按提示处理；详细日志在 `~/.codex-harness-adapter/<引擎>/`。
- **某个 harness 显示“没装”：** 装好它的命令行后重启服务；或者在 Litch 的设备管理里给它填“命令行路径”（设置键 `harness.<标识>.cliPath`）；或者用它自己的环境变量指路（Claude Code 是 `CHA_CLAUDE_CLI`，Pi 是 `PI_CLI`，DeepSeek Harness 是 `CHA_DSH_CLI`）。
- **连接失败：** 确认服务仍在运行，端口和私钥与启动输出一致。
- **模型不可用：** 先在原生 Claude Code / Pi 中检查登录和模型配置。

[更多配置](docs/guide/configuration.md) · [开发说明](CONTRIBUTING.md)

---

基于 [fuergaosi233/claude-codex](https://github.com/fuergaosi233/claude-codex)，通用 SSH 实现来自 Tyrs Hand。[MIT](LICENSE) · [第三方许可](THIRD_PARTY_NOTICES.md)
