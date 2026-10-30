# 手动 Computer Use 真模型实测

此目录不进入 CI。使用一个独立 `codex app-server`，给它直接下发仓库中的
`computerToolsSpec('darwin', true)`，调用由同一份 `createComputerExecutor`、`HelperSupervisor`
和本分支 Swift 助手处理。工具名称、说明、参数和成功结果与 Litch 相同，
不经过 Litch 界面、会话树或正在使用的桌面实例。

M10 起显式用 `computerToolsSpec('darwin', true)` 下发批量工具；批内每个应用也须在四个应用的
允许范围内。连续实测期间累计两次用户活动等待超时即停止后续任务，等待重新约定空闲时段，
不降低原生让行阈值。批量调用在统计中算一次工具往返；其提交的动作数保留在调用参数中。

运行器额外拒绝用例允许范围外的应用及超过 160 次的调用；`list_apps` 仍返回原生应用清单。
它不自动同意审批，不修改 TCC，不接入正式助手。真实屏幕不是沙箱：只在用户授权的
无人操作时段运行；出现权限弹窗必须交给用户，不能把预检通过当作实际截图已获准。

前提：Node 24、支持命名空间动态工具的 Codex（已验证 0.163.0）、Swift、已授权的
独立测试助手。先按 `apps/computer-use/probes/integration/README.md` 构建本分支的
签名探针。它只更换隔离入口，复用产品 Engine、Capture、Input，正式助手的鉴权不变。
签名阶段须能读取用户已配置的签名身份；运行阶段的 HOME 独立。

```sh
# 以下路径都由操作者提供，不使用全局 Codex 配置来运行。
node scripts/cu-trial/run.mjs --preflight \
  --helper "$TRIAL_HELPER" --out .artifacts/cu-trial/preflight-1
node scripts/cu-trial/run.mjs --execute \
  --codex "$TRIAL_CODEX" --auth-source "$TRIAL_AUTH_SOURCE" \
  --helper "$TRIAL_HELPER" --out .artifacts/cu-trial/round-1
node scripts/cu-trial/summarize.mjs .artifacts/cu-trial/round-1 .artifacts/cu-trial/round-2
```

`--auth-source` 是经用户明确许可读取的 Codex 配置目录。脚本只复制 `auth.json`、
模型目录 JSON 和模型提供方配置，不复制 MCP、插件、技能、项目、历史或 notify。
配置副本只在本次 `/tmp/litch-cu-model-*` 的 `CODEX_HOME`；HOME、工作目录与 TMPDIR
同样隔离。模型提供方的 `env_key` 如需环境凭据，由操作者环境提供，不输出其值。
临时目录权限为 0700；结束时删除副本，不修改源文件。不要把认证或环境变量写进记录。

用例在 `cases.json`，可通过 `--cases` 指定另一份数据。默认只操作文本编辑、访达、
计算器和系统设置；系统设置仅查看，不改值。文件只能写入 `/tmp/litch-cu-trial`，
该目录必须原先不存在，脚本不接管已有目录。操作者需事先保存这几个应用的工作。
不预先打开空白文档；应用启动后没有窗口也属于实测范围，由模型自行新建。
脚本打开所需应用，由模型新建自己的文档和访达窗口；最后要求模型只关闭自己新开的
窗口，再终止脚本新启动的应用、助手与 Codex，删除测试目录及临时配置。
原先运行的应用不退出。若系统弹窗挡住关闭窗口，必须人工检查是否遗留测试窗口。
终止进程不等于丢弃 TextEdit 自动保存草稿。清理须通过界面关闭本轮测试文档；恢复的旧草稿
只有内容精确匹配用例两段文字才可选择“不保存/删除”。操作者重开 TextEdit，确认草稿不再
恢复，再退出本轮启动的 TextEdit；不得手动删除自动保存目录或处理用户自己的文档。
新启动进程按启动前后进程清单登记（不以是否已经出现窗口判断），写入 `launched.jsonl`。
系统授权/登录拦截后结束本轮，不继续消耗后续任务；恢复后用新记录目录重跑。

`--out` 必须是新的记录目录，推荐 `.artifacts/`（Git 忽略）。记录包括实际工具定义、
每次调用的参数/耗时/完整结果、全部 app-server 事件、每个回合耗时与文件核验；
截图单独存放，JSONL 使用文件名引用。截图可能含允许应用窗口中的可见资料，
分享前须人工检查。认证副本、原始个人配置和实测记录不能提交。

加 `--preview` 会在观察到窗口后打开本轮助手的浮动预览，记录 `automation.jsonl` 与
`preview-lifecycle.jsonl`。结束前保存助手自身 NSView 的位图（不是整屏截图），结束后
记录可见预览窗口号；0 表示浮窗已隐藏。该检查验证本地助手，不代表完整 Litch UI 链路。
TextEdit 与 Finder 每项结束时分别保存测试 RTF 副本，用 AppKit 只读核验两段文字和第二段的粗体属性；
同时记录原路径和移动后路径是否存在，避免后一项失败掩盖前一项成功。
汇总器另按任务、工具拆分调用与耗时，并对并发工具区间取并集；墙钟减工具占用只是
模型、网络、编排和预览审计的合计，不能视为纯模型思考耗时。

进程被强制杀死时 `finally` 无法保证运行。先确认该次 Codex/探针已退出，再依据
该次运行日志检查对应 `/tmp/litch-cu-model-*` 与 `/tmp/litch-cu-trial`，对确认属于
本轮的字面量绝对路径进行清理，不使用通配符删除临时目录。
# 保存面板确定性回归（不调用模型）

`save-panel.mjs` 使用同一产品执行器和独立签名探针。仅在用户允许占用电脑时手动运行；
TextEdit 必须已退出，`/tmp/litch-cu-trial` 和输出目录必须不存在。缺权限、用户介入或任何断言
失败都会停止，不能绕过提示继续；失败时按日志核对测试文档并清理，不接管用户文件。

```sh
PATH=/opt/homebrew/opt/node@24/bin:$PATH node scripts/cu-trial/save-panel.mjs \
  '/绝对工作树/apps/computer-use/.artifacts/integration/Litch Background Input Probe.app' \
  '/绝对工作树/.artifacts/cu-trial/save-panel-regression'
```

验证新建、两段文字及第二段粗体、保存面板 cmd+shift+g、正确目录落盘、RTF 字体属性、关闭并
重开无恢复及系统修饰键无残留。成功后退出本次应用、删除测试目录和助手临时配置，RTF 证据及
工具结果只留输出目录。`inspect-keyboard-target.swift` 只读焦点的公开/实际 PID 和测试目标标记，
不发送事件、不导出目录文件列表。该验证独立于真模型性能表，不能算作新一轮模型验收。
