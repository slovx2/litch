# 手动 Computer Use 真模型实测

此目录不进入 CI。使用一个独立 `codex app-server`，给它直接下发仓库中的
`computerToolsSpec('darwin')`，调用由同一份 `createComputerExecutor`、`HelperSupervisor`
和本分支 Swift 助手处理。工具名称、说明、参数和成功结果与 Litch 相同，
不经过 Litch 界面、会话树或正在使用的桌面实例。

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
脚本打开所需应用，由模型新建自己的文档和访达窗口；最后要求模型只关闭自己新开的
窗口，再终止脚本新启动的应用、助手与 Codex，删除测试目录及临时配置。
原先运行的应用不退出。若系统弹窗挡住关闭窗口，必须人工检查是否遗留测试窗口。
新启动进程按启动前后进程清单登记（不以是否已经出现窗口判断），写入 `launched.jsonl`。
系统授权/登录拦截后结束本轮，不继续消耗后续任务；恢复后用新记录目录重跑。

`--out` 必须是新的记录目录，推荐 `.artifacts/`（Git 忽略）。记录包括实际工具定义、
每次调用的参数/耗时/完整结果、全部 app-server 事件、每个回合耗时与文件核验；
截图单独存放，JSONL 使用文件名引用。截图可能含允许应用窗口中的可见资料，
分享前须人工检查。认证副本、原始个人配置和实测记录不能提交。

进程被强制杀死时 `finally` 无法保证运行。先确认该次 Codex/探针已退出，再依据
该次运行日志检查对应 `/tmp/litch-cu-model-*` 与 `/tmp/litch-cu-trial`，对确认属于
本轮的字面量绝对路径进行清理，不使用通配符删除临时目录。
