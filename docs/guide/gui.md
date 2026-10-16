# Codex 桌面端配置指南

先按[开始使用](/guide/getting-started)完成构建，运行 `npm start`，等待需要的引擎显示“SSH 就绪”（英文输出时是“SSH ready”），并保持终端运行。
使用 Homebrew 后台服务时无需保持终端，下文的启动日志可用 `codex-harness-adapter ssh-config` 查看。

## 1. 可选：设置 SSH 别名

把启动日志中的完整 `Host` 配置段复制到 `~/.ssh/config`（Windows 为 `%USERPROFILE%\.ssh\config`）。没有目录或文件时创建即可。
也可以运行 `codex-harness-adapter ssh-config > ~/.ssh/config.d/codex-harness-adapter`（源码方式为 `npm run --silent ssh-config`），再在 `~/.ssh/config` 顶部加入 `Include ~/.ssh/config.d/codex-harness-adapter`。
可把 `Host` 后的别名改为 `claude-local`、`pi-local` 等易识别的名称；其他字段保留启动输出的值。

每个引擎使用独立的端口和私钥。默认 Claude 为 `127.0.0.1:7331`、Pi 为 `127.0.0.1:7332`。
可用 `npm start -- --claude-port 7441 --pi-port 7442` 更改端口；单引擎可用 `npm start -- --harness pi --port 7442`。
更改后同步更新 SSH 配置和桌面端的连接参数。

## 2. 在桌面端添加设备

打开 **设置 → 连接 → SSH → 添加**，选择刚配置的别名；也可以跳过 SSH 配置文件，选择 **手动添加**。

手动添加时按启动日志填写主机 `127.0.0.1`、对应端口、用户 `local`，以及 `IdentityFile` 指向的专用私钥。
主机指纹应与启动日志一致。只启用了一个引擎时，只添加对应设备。

## 3. 添加项目

回到主界面，点击 **添加项目** → 展开 **远程设备** 下拉菜单 → 选择刚添加的设备 → 选择项目目录并添加。
也可以在 **设置 → 连接 → SSH** 的设备行点击文件夹图标 **创建项目**，填写名称并选择目录。
虽然文件就在本机，也要从对应 SSH 设备添加项目，才能让会话使用所选引擎。

现在可以创建会话、选择模型、发送消息，并在桌面端处理命令和文件审批。按 Ctrl-C 停止 `npm start` 会关闭本次启动的入口，保留会话和密钥；下次再次运行即可连接。
Homebrew 后台服务用 `brew services stop|restart codex-harness-adapter` 控制，同样保留会话和密钥。

本地入口不需要系统 sshd，也无需设置全局 `codex` shim、修改 `~/.zshenv` 或全局 PATH。
SSH 包装器由适配器自动提供。更多背景见 [OpenAI 官方连接说明](https://learn.chatgpt.com/docs/remote-connections)。

## 连接排查

配置别名后，可在另一个终端运行 `ssh codex-harness-adapter-claude 'codex --version'`（使用 Pi 或自定义别名时替换名称）。
环境检查使用 `npm run doctor -- --harness claude-code` 或 `npm run doctor -- --harness pi`；Homebrew 安装用 `codex-harness-adapter doctor --harness …`。
会话报 401 等认证错误时，先在终端确认原生引擎已登录（Claude 用 `claude auth status`），并检查 Pi 所选模型的服务地址可以访问。
只安装一个引擎时，指定 `--harness`，避免全量诊断把未安装的引擎也计为失败。

Windows 终端验证需要 OpenSSH Client。自动化 SSH/SDK 测试不代表桌面 GUI 已验收；实际客户端仍需验证。

## Picking a model

Codex App's model menu stays a **model selector** only — pick `Claude Sonnet`,
`Claude Opus`, `Claude Fable`, `Claude Haiku`, etc. The active Claude Code **route**
(which backend serves the turn) is chosen outside the App through the runtime environment; see
[Backends](/guide/backends).

The default picker exposes Claude Code aliases; model availability and the version
an alias selects depend on your account, provider, and Claude Code version. The
list is not an account entitlement check. `CHA_CLAUDE_MODELS` replaces the
default Claude list when you need to customize it.

**Claude Opus Plan / Sonnet Execute** keeps the `opus-plan` option ID and maps to Claude
Code's `opusplan` hybrid mode: Opus during planning, Sonnet during execution.
Selecting it does not itself enable plan mode, so an ordinary conversation may
correctly run on Sonnet. Choose **Claude Opus** to use Opus throughout. See the
[Claude Code model configuration](https://code.claude.com/docs/en/model-config#opusplan-model-setting).

## 自动化验证

`npm run test:local-ssh` 验证专用 SSH 入口、真实 SDK 与本地 mock provider，不使用个人模型凭据。
桌面界面中的设备添加、项目选择和审批操作需要单独验收，并记录客户端版本。
