# DeepSeek Harness 适配器（实验性）

把 DeepSeek Harness（dsh）的原生会话映射到 Codex app-server 协议。当前是实验性入口：覆盖线程列表、发消息、逐字流、提权审批、向用户提问（含中断与重启后的历史回放），其余能力见文末。面向用户的说明在[配置文档](../../docs/guide/configuration.md)。

## 接入方式

dsh 本体不随适配器分发：适配器使用用户自己安装的 `dsh`，默认从 PATH 查找，`CHA_DSH_CLI` 可指定路径。它看护一个长驻的 `dsh --profile web --no-open --port 0` 子进程，经 Web Remote 接口（HTTP 一元调用加 WebSocket 流）驱动全部会话：

- 历史只存在 dsh 自己的会话存储里，适配器每次从 `session/follow` 的快照回放，不另存一份；适配器数据库只放归档标记、项目归属等界面元数据，和客户端发来的输入的原样（见下一条）。
- 回给客户端的用户消息是它发来的样子。dsh 的会话记录里图片只有它另存的附件号（收图时可能缩小、转码过），所以适配器把每次发来的输入原样记一份（适配器数据库里，按会话和提交标识，就是 dsh 那条用户消息上的 `rpcId`），实时回显和重读历史时用户消息的内容就是它；dsh 自己分叉出来的会话带着原来的提交标识，到上一级会话名下也找得到。这一份没有时（库丢了、升级之前发的消息）照 dsh 的记录来：图片按附件号从 dsh 取回（`session/attachment`），一律成了带地址的图片，本地文件的路径没有了。技能也是这样回出一项技能，库丢了时是交给 dsh 的那一句“/名字”（不照字去认：会把用户自己写的“/名字”也当成技能）。预览取用户自己写的字。没打开的会话预览和名字出自 dsh 的会话清单，那里是照交给 dsh 的那一句截的，名字分不出是不是兜底标题，还可能是旧的，所以会话打开着时适配器把该报的预览和名字记一份，列清单时照它报。
- 回合、条目标识由 dsh 的回合号、步号、块序号和工具调用号推出，实时增量与落盘消息、重启前后都一致。
- dsh 只在模型申请沙箱提权时询问，裁决只有"允许这一次"和"拒绝"；对应 Codex 的命令审批与文件改动审批。
- 模型调 dsh 的提问工具（`ask_user_question`）时，dsh 转来问用户（`user-questions/request`），适配器转成 `item/tool/requestUserInput` 发给会话的订阅连接，先答的生效，答案交回 dsh、由它写成工具结果给模型；工具调用本身是一个动态工具条目（`dynamicToolCall`，和 Claude 入口一样），结束时每道题一行答案。dsh 的题都能自己写一段，所以都标 `isOther`；协议的题上没有多选的标记，多选题到客户端和单选题一个样子。问不成（没有连着的客户端、拿着请求的连接都断了、客户端回了错误）交回 dsh，模型拿到“没有人应答”的报错，回合接着走；回合被打断时不替用户答，dsh 撤回提问，模型那边记的是“用户回答之前就中止了”。
- 权限三档与 Codex 一一对应（`read-only`、`workspace-write`、`danger-full-access`），切换时向会话执行 `/permission`。
- 会话的模型和强度问的是 dsh：选过的、上一次请求用过的它记着；两样都没有的新会话到发请求时用它当时的默认（模型目录里的默认项），`thread/start`、`thread/resume` 的应答里报的就是这个，和 `model/list` 里 `isDefault` 的那一项一致。dsh 的默认不是固定的：在任何会话里选一次模型，它都把那一个存成新的默认。
- 临时线程（`thread/start` 带 `ephemeral: true`，桌面端生成标题、摘要时用）只存在于适配器内存里：dsh 没有不落盘的会话，也没有删除会话的接口，所以不为它建 dsh 会话；回包带 `ephemeral: true`，不进线程列表，无人订阅即卸载。
- dsh 没有结构化输出：临时线程上带 `outputSchema` 的回合不经模型，以空结果正常结束，客户端按"没有结果"走自己的回退；临时线程上的普通回合和普通线程上带 `outputSchema` 的回合如实拒绝。
- 线程标题用 dsh 自己生成的（`session/title` 转成 `thread/name/updated`），它的兜底标题（模型标题出来之前先顶着的、头一句开头的几个词，点了技能的是“/名字”打头）不算：不当名字、不通知，没有名字的会话客户端显示预览。dsh 把改名视为用户标题并钉住、之后不再自动生成，所以在 dsh 起过标题之前收到的 `thread/name/set`（桌面端会在首条消息发出前把消息原文写回）只当临时名，不转给 dsh；起过标题之后的改名才写进 dsh。
- 回合由适配器先建、提示词随后才交给 dsh。打断（`turn/interrupt`）和插话（`turn/steer`）都等提示词交到了再发给 dsh：回合刚开始就打断也停得下来，刚开始就插话也并进这个回合、排在原来那句后面。
- 没说过话的会话不进线程列表，和原生 codex 一样。说没说过话问的是 dsh：它的会话清单自带“空白”一项；没打开的会话这一项出自它的缓存，缓存里没有这个会话时它一律报成不空白，这种的另问一次（`session/projections`）再定。
- dsh 没有删除会话的接口，所以新建会话时会失败的核对（项目在不在）放在建 dsh 会话之前，不留下空会话。
- 关 dsh 只能发结束信号（Web Remote 里没有“请收尾退出”的请求），而且它只认头一个：收场途中再来一个就丢下收尾立刻退出，刚完成的回合可能还没落盘。适配器对一个 dsh 进程至多发一次：自己被信号要求退出时先等 dsh 断开连接（同一个进程组里的它多半也收到了，收场的头一件事就是断开连接），等不到才发；连接是 dsh 那头先断的先等不发，过了它自己的收场上限（5 秒）还在才发。等它收尾 6 秒（适配器被信号要求退出时 4 秒，主进程给运行时的时限是 5 秒），到点才强杀。
- dsh 没有对应物的方法（`mcpServerStatus/list`、`app/installed`、`plugin/installed`、`marketplace/add`）答复 -32004"不适用"，与 Claude 入口同一做法；`thread/goal/get` 如实回报没有目标。
- 技能清单（`skills/list`）问的是 dsh 自己（Web Remote 的 `skills/list`），适配器不另扫目录：列出来的就是用户能用 `/名字` 点名的那些。dsh 的这个接口按会话问，所以每个工作目录配一个只用来问技能的 dsh 会话（会话号 `session-skills-` 开头，由目录定），从不发消息、不进线程列表；dsh 没有删除会话的接口，它建了就一直在。来源范围是按文件所在的目录归的（项目的 `.dsh/skills`、`.agents/skills` 算仓库的，`<DSH_HOME>/skills`、`~/.agents/skills` 算用户的，其余算系统的）。dsh 不往远程客户端推技能变化，适配器每两秒问一遍，变了给问过清单的连接发 `skills/changed`。别的程序改了技能文件，dsh 要等系统的文件事件才知道，系统忙时会迟，这期间清单是旧的，`forceReload` 也不能让它重扫。dsh 没有逐项的开关，`enabled` 恒为真，`skills/config/write`、`skills/extraRoots/set` 不支持。消息里的技能输入化成单独一行的 `/名字`，由 dsh 展开；回显和重读历史里它仍是一项技能。注意 `DSH_HOME` 是适配器自己的那一份，用户放在 `~/.dsh/skills` 里的技能读不到。

## 版本

对用户安装的 dsh 只设下限（`src/versions.mts` 的 `dshMinimum`，当前 `0.2.0-rc.2`，与 `protocol/versions.json` 的登记一致并有测试核对），不低于它即可。dsh 还没有稳定版，下限落在预发布号上，所以 dsh 入口按 semver 比较预发布标识（共用的下限判断只接受稳定版）。

Web Remote 是 dsh 的私有接口，没有版本协商，高于下限的新版本可能不兼容。实际验证过的版本单独记在 `dshVerified`，不参与放行：遇到方法不存在、参数被网关拒绝或返回结构不符时，报错会带上当前 dsh 版本和这份清单；启动未验证的版本时在运行日志里提示一次。dsh 自己没办成的事不算接口不符（它回的错误码是 `gateway/internal`、`gateway/bad-request`、`gateway/cancelled` 的，比如工作目录那个位置是个文件、会话建不出来），带着它的原话报，不提版本。

## 运行

```sh
npm run setup                                         # 根目录的 setup、build、typecheck 已包含本包
bin/codex-harness-adapter doctor --harness dsh
bin/codex-harness-adapter start --harness dsh         # 只启动 dsh 入口
bin/codex-harness-adapter start                       # 全部启动：检测到本机装有 dsh 才带上 dsh 入口
```

默认 SSH 端口 7333（全部启动时用 `--dsh-port` 修改），主机别名 `codex-harness-adapter-dsh`。全部启动时 dsh 是实验阶段的特例：没装 dsh（`PATH` 里没有且未设置 `CHA_DSH_CLI`）就不出现、不告警；装了但版本低于下限或启动失败时与另外两个入口一样只告警。`DEEPSEEK_API_KEY` 只从启动环境继承（或写在 `<home>/env`），适配器不读取 `~/.dsh` 下的登录态；没有密钥时回合以 dsh 的原始报错结束。

| 变量 | 作用 |
| --- | --- |
| `CHA_DSH_CLI` | 用户安装的 dsh 可执行文件；不设置时从 PATH 查找 `dsh` |
| `CHA_DSH_HOME` | 适配器状态目录（CLI 启动时自动设为 `<home>/dsh`）；dsh 的 `DSH_HOME` 固定在其下的 `dsh-home` |
| `CHA_DSH_SESSION_LOG=1` | 保留 dsh 默认的会话日志上传；不设置时适配器启动的 dsh 一律关闭上传 |
| `CHA_DSH_TRACE=<文件>` | 调试用，逐行记录与客户端往来的协议消息 |
| `DSH_TELEMETRY_DISABLED` | 未设置时置为 `1` |

## 验证

```sh
export CHA_DSH_CLI=<本机已安装的 dsh>      # PATH 里有 dsh 时可省略
npm run test:dsh                         # 包级测试：回环 mock 模型，往来消息按协议 schema 校验
npm run test:dsh-ssh                     # 隔离实例经真实 SSH 走一遍四件事后清理退出（macOS）
node scripts/dsh-poc-serve.mjs --gui     # 同一实例常驻，写入 ~/.ssh/config.d/cha-dsh-poc 供桌面端连接
```

测试与隔离实例都使用假密钥、临时目录和回环 mock 模型，不读取个人配置；隔离实例整体运行在只允许回环外连的沙箱里。测试需要本机已安装 dsh，没有时直接失败而不是跳过，因此不并入根目录的 `npm test`；CI 的 `dsh` 任务按 `protocol/versions.json` 的 `dshMinimum` 把 dsh 装到临时前缀后运行。

## 尚未覆盖

历史分页（快照之外更早的记录）、计划模式（dsh 只能用 `/plan` 命令打开，适配器不发；模型自己调 `exit_plan_mode` 只会得到“只在计划模式里可用”的报错，这个工具 dsh 不让单独关）、分叉与回滚、压缩、子代理展示、MCP 管理、技能的开关与额外目录、`thread/timeline/list`。结构化输出也不支持（见上）。只在 macOS 上验证过；真实桌面界面已在 ChatGPT.app 26.1007 上用回环 mock 模型验证过，真实 DeepSeek 端点尚未经适配器端到端验证。
