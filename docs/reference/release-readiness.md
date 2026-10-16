# 发布验收范围

当前发布线为开发预览版。客户端契约固定为 Codex app-server 0.157.1，
`protocol/versions.json` 中的 `releaseReady` 保持 `false`，直到完成真实桌面验收。

## 平台与入口

Claude Code 和 Pi 共用本地 SSH 启动器；独立入口只监听 `127.0.0.1`。

| 平台 | 传输 | 终端 | 启动方式 |
| --- | --- | --- | --- |
| macOS（Apple Silicon） | Unix socket | POSIX PTY | 前台 Go CLI，或 Homebrew `brew services` 后台服务 |
| macOS（Intel）/ Linux | Unix socket | POSIX PTY | 前台 Go CLI |
| Windows 原生 | 本机命名管道 | ConPTY | 前台 Go CLI `.exe` + Git Bash |

Windows 的命令执行需要显式完全访问。受限命令缺少操作系统沙箱时直接报错，
不自动降级；需要系统沙箱可在 WSL2 内使用 Linux 运行方式。

## 自动检查

`.github/workflows/ci.yml` 执行以下检查：

- macOS / Linux：格式、类型、构建、Claude/Pi 测试、Go 测试、文档构建。
- Windows Server 2025 x64：类型、构建、路径转换、沙箱权限边界、旧数据库拒绝、Go 测试。
- 三个平台：`test:local-ssh` 使用真实 SSH、真实 SDK 和回环 mock provider，验证版本探测、
  WebSocket proxy、模型回合和历史读取，不使用个人模型凭据。
- Go 测试覆盖公钥拒绝、HostKey、转发策略、PTY 调整尺寸、SFTP 写文件和生命周期。
- Rust 协议 crate 使用锁定依赖运行契约 fixture 测试；它不是生产运行时。

源码安装和所有依赖版本以[适配器说明](https://github.com/slovx2/litch/blob/main/ADAPTER.md)为准。
Linux 运行包由独立 `runtime-artifacts.yml` 构建并验收。
macOS 通过 `slovx2/homebrew-tap` 分发，bottle 由该 tap 的 CI 构建（目前仅 Apple Silicon），依赖 Homebrew 的 `node@24`；Windows 仍为源码安装，没有安装器或后台服务。

## 仍需真实桌面验收

自动 SSH 测试不能代替 Codex 桌面界面。发布记录应明确客户端版本，以及项目选择、
流式回复、文件修改、审批、提问、中断、历史恢复的实际结果。
2026-10-08 在 macOS ChatGPT.app 上通过 Homebrew 后台服务完成了部分实测：Claude 与 Pi 均可添加 SSH 连接、选择项目目录并完成文本回合；语音聊天入口报错。
文件修改、审批、提问、中断、历史恢复尚未在桌面端逐项验收，因此预览发布不声称桌面全功能已经通过。

## 数据和发布边界

新适配器不读取旧配置、状态路径或 `tyrs-*` 投影标记，显式打开旧格式数据库时报错。
初始化和清理不会删除或迁移旧数据库及原生会话文件。

发布前确认目标提交的 CI 和制品校验结果，发布说明区分实现、自动验证和待验收项。
适配器发布不隐式更新 Tyrs Hand 或生产环境。
