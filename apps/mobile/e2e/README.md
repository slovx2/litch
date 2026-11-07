# 移动端的自动化用例

两组：单元测试（纯逻辑，秒级，不要模拟器）和端到端（安卓模拟器上的 release 包，Maestro 驱动）。

## 真机上与正式包并存

`fixture/26-tailscale.yaml` 验内嵌节点初始化、可选引导、HTTPS 地址校验、清状态和未登录保护。
控制服务器使用 `https://127.0.0.1:9`，不打开真实登录页、不需要账户。默认包名为 `dev.litch.app`；
独立验收 dev 包可给 Maestro `-e APP_ID=dev.litch.app.dev`。
macOS 上若驱动报告 `Connection refused: localhost/[::1]:7001`，仅给该次 Maestro 命令设置
`JAVA_TOOL_OPTIONS=-Djava.net.preferIPv4Stack=true`，不要改机器全局 Java 设置或重启别人的 ADB。

需要真机验收时，在 `apps/mobile` 以 `LITCH_MOBILE_DEV=1` 运行 prebuild 和构建，
得到 `dev.litch.app.dev`（Litch Dev），深链为 `litch-dev://`。它的文件、钥匙、系统后台权限
与正式包分开；只配对隔离设备服务，不复制正式应用的私钥。默认构建仍是正式包。
现有 `e2e.mjs` 和流程里的包名/深链是正式版，不能直接拿它们操作已装正式版的用户真机。

后台断开验收：单测 `test/background.test.mjs` 验设置与迟到事件，`mobile/sshtransport` 的
Go 测试验启动时钟（包含深睡）、到期取消、脚本/配对的暂停闸门和握手中的真实 TCP 关闭；
真机仍须完整等待默认五分钟，并补灭屏观察。非唤醒、非精确闹钟可能延迟，
记录实际断开时刻、后台不重连及回前台恢复，不在回前台补断。
系统后台权限由用户在 Litch Dev 的应用设置中手动开启；验完卸载开发包并清理隔离服务。

## 单元测试

```sh
cd apps/mobile && npm test        # 或者仓库根目录 npm run mobile:test
```

- Node 24 自带的测试运行器直接读 `src` 下的 `.ts`（`--experimental-transform-types`：`session-store.ts` 用了参数属性，纯类型剥离不认）。
  `test/register.mjs` 补 Metro 替我们做的几件事：`@litch/core` 的映射、不带扩展名的相对引用、原生模块和导航换成 `test/stubs/` 下的替身。
- 不需要装任何依赖（`node_modules` 都不用），只测不依赖 React Native 的那一层；带 React 的组件不在这里测，交给端到端。
- 覆盖：`blocks`（流式切块）、`rows`（对话区的行）、`session-store` 接在模拟核心上（新建会话收到流式回答、尾巴单独交出、审批答完、
  展开一组、停了不再交、会话缓存）、远程脚本真交给本机 `sh` 跑（探测、启动、代理时脚本整段读完再执行）、SSH 报错的认法、
  链接改写、会话列表、差异行、终端挑选、本地存储（草稿、新建会话页记住的选择、设备配置、主机钥匙、远程开发参数）、测试链接。
- 覆盖里还有 harness 详情设置（`test/hconfig.test.mjs`）：provider 分上下两段与筛选、要回调转发的登录在手机上能不能走完、值的说法、分组。
- 覆盖里还有定时任务（`test/tasks.test.mjs`）：时刻的写法整理、数字栏、任务和运行记录的行、文案键不和桌面撞名（日程描述和表单逻辑用桌面界面那一份，测在 `packages/ui/test/tasks-logic.test.mjs`）。
- 覆盖里还有建议任务（`test/proposals.test.mjs`）：哪条调用画成几张卡（收尾按 callId、start 按提案号）、没带建议的收尾不画也不拆开过程组、
  提醒和唤醒只画提示不画用户消息、列表的排法、“改了再开始”只发改过的（含完成后唤醒）、接模拟核心点“不要”后卡片跟着变、文案键。
- 覆盖里还有工作树（`test/worktrees.test.mjs`）：新建页起点的选项与发给设备的起点、按工作区记住位置和起点、“改了再开始”的开关进 overrides、“工作树”一页的说法，接模拟核心带起点建会话。
- 本机实测：80 条，约 3 秒。

## 端到端

```sh
cd apps/mobile && npm run e2e -- [--build] [--only mock|fixture|<流程文件>] [--tags smoke] [--keep]
```

入口 `scripts/e2e.mjs`：不给 `--serial` 就在 `--port`（默认 5590）上无窗口、只读地起一台（默认 AVD `tyrs_hand_e2e_api35`）；
那个端口上已经有设备（不管什么状态）就报错，让你换 `--port` 或者用 `--serial` 指定，不拿别人的来用。
然后装包，要夹具的流程先起夹具（`scripts/fixture.mjs`，真的适配器经 SSH、隔离的 Pi、回环上的假模型），跑完收尾：
停夹具、只撤夹具加的那两条 `adb reverse`、关掉自己起的模拟器（`--serial` 给的不关）、删临时目录。
产品断言失败直接返回非零。只有结构化失败命令是 `launchApp`，且本次尝试有 `device offline` 或 ADB reverse 丢失证据时，才等设备上线、恢复映射，从 flow 开头重跑一次。其他失败不重试。首次失败的 JUnit、截图和日志保留在 `attempt-1/`，恢复原因写入 `infrastructure-recovery.json`，重跑另存 `attempt-2/`；summary 显示“基础设施重试”及触发特征。
Ctrl-C 打断时照样收完尾，退出码 130。

Maestro 的调试输出（失败时的截图、日志）默认放在临时目录里、跑完删掉（`--keep` 才留下）；设了 `LITCH_E2E_ARTIFACTS=<目录>`
就放到那个目录并留着，CI 每片都上传 JUnit、逐 flow 耗时及首次失败诊断。

Full 的 `mobile-build` 只构建一次 x86_64 APK，上传清单与 APK；三个 `mobile` shard 各自下载并核对源码 SHA 和 APK SHA-256。
`--shard 1/3`、`2/3`、`3/3` 按历史首轮耗时均衡分配；24 条 flow 每片 8 条，新增 flow 自动纳入。
每片独立 runner、模拟器与夹具，不共享 Maestro 的 7001 端口。

CI 掉线诊断：`LITCH_E2E_DIAGNOSTICS=1` 在 APK 安装前订阅 ADB 的设备状态，并分段保留连续 logcat。
`android-events.jsonl` 对齐安装、夹具、每次 flow、reverse 丢失/补回和恢复的时间；`android-logcat-*.txt`
保留掉线前的日志（每段最多 16 MiB，写满或断线重接后续新段；最多 12 段，耗尽总预算才截断并记录事件），
不会覆盖第一次失败。宿主的 CPU、内存、
AVD、SDK 和 KVM 信息在 `android-host.json`，传输层 trace 在 `adb-server.log`（最多 32 MiB）。
观察流断开后可重新订阅，只恢复日志读取，不重启设备/ADB、不重跑测试。诊断缺失会报告，不改测试结果。

手动 `full.yml` 可给 `domains='["mobile"]'`、`run-ci=false`，只验证手机领域。稳定性实验参数
`mobile-disable-vulkan` 默认 false，true 只增加模拟器参数 `-feature -Vulkan`；两组使用同一工作流 SHA、
同一 emulator build 和全 24 条 flow。它是诊断实验，尚不能视为掉线修复；其他 GPU、核数、内存和断言保持。
不要把不同 runner 上的一次通过认作因果证据，需比较多轮掉线/传输事件、首次失败及重试，而不只看最终绿灯。

流程在 `flows/`，靠测试链接和 testID 驱动，不点坐标；每个流程开头清掉应用数据（`_shared/fresh.yaml`），互不依赖、可以单跑。

| 流程 | 走的路径 | 本机耗时 |
|---|---|---|
| `mock/01-home` | 模拟核心：首页四台设备 → 会话列表 | 6 秒 |
| `mock/02-new-session` | 新建会话页发第一句 → 详情页收到流式回答、回合结束 | 18 秒 |
| `mock/03-approvals` | 等审批的会话：命令审批、MCP 工具审批一张张答完 | 12 秒 |
| `mock/04-question-form` | 三道题的提问（单选、自己写、单选）→ MCP 表单填完交上 | 28 秒 |
| `mock/05-plan` | 计划模式：Claude Code 自己问要不要执行；只有 codex 的设备上界面来问，点“执行” | 49–53 秒 |
| `mock/06-tasks` | 定时任务：首页入口 → 列表 → 详情里立即运行 → 新建每周一、三的任务（看到“下一次”的预览）→ 建好进详情 → 任务跑出来的会话顶上有“定时”那一条 | 53 秒 |
| `mock/07-harness-settings` | harness 详情设置：设备详情里 Claude Code 的入口 → 配置改强度、保存 → 账号：Anthropic 账号 Console 粘贴授权码登录 → API key 供应商填密钥 → 网关从 provider 拉取型号、勾上一个写回清单、保存 → MCP、指令文件只读 | 约 75 秒（320x640） |
| `mock/08-proposals` | 建议任务：说“提个子会话”→ 三张提案卡、顶上的提示条 → 一张从“⋯”里“忽略”、一张过期 → 第三张从“⋯”里“编辑后开始”（改标题、关掉完成后唤醒）→ 卡片下面是子会话 → 菜单里的建议任务列表，点一条回到对话 | 51–56 秒 |
| `mock/09-model-list` | 模型清单：build-01 上先发“race the config”（抢先改配置）→ Codex 详情设置的“模型”：开始自定义（导入整份自带目录）→ 点一行删一项、挪一项 → 以 GPT-5.5 为底稿新增一项（换模型名、上下文）→ 保存撞上冲突、草稿留着 → 再存成了、顶上提示重启 → 界面里确认后恢复自带目录 | 约 2 分钟（320x640） |
| `mock/11-goal` | 持续目标：打开 build-01 上的 Codex 会话 → 打 `/` 点斜杠单子的 `/goal`、写目标发出 → 输入框上方目标那一行 → 续做回合开头一行 → 达成后那一行没了、回答下“目标已达成 · 用时 N” → 再设一个：用时那一句没了，暂停、继续、清除 | 约 50 秒（320x640） |
| `mock/12-offer-held` | offer 卡降成提案：说“new task for Pi”→ “新会话 / 在这里做”的卡点新会话 → 简报开在 Pi 上收不紧沙箱，卡片降成待开始的提案、写明原因 → 点开始，卡片下面是子会话 | 39 秒 |
| `mock/13-send-mode` | s2 停在命令审批上：默认立即发送的插话正文可见、没有排队托盘 → 设置里那一行点开选择单改为排队，再发一句进入托盘 → 停止后保留待发，切走再回来仍暂停 → 显式发送只产生一份气泡，先前插话仍在 | 51 秒（320×640） |
| `mock/14-agents` | 子代理：说“use sub-agents”→ 回合说完整段过程收成一行（3 个子代理）→ 点开，三条子代理（完成、已停止、失败的字）→ 过程组展开、末尾“收起”收回 → 点失败的那条进子代理页，看到原因 | 未计时 |
| `mock/15-worktrees` | 工作树：新建页在 litch 工作区选“新工作树”、起点挑 release/0.18 → 说“提个子会话”→ 详情副标题写分支、提案卡“新工作树”开关默认开 → 菜单“工作树”一页：分支、起点、合入 release/0.18 → 会话列表里示例工作树会话的行写着分支 | 77 秒 |
| `mock/16-mermaid` | mermaid 卡片：说“draw a diagram”→ 第一张画出缩略图、第二张语法错写原因 → 点开全屏 → 切到源码 → 返回键关掉 | 未计时 |
| `mock/19-manager-workbench` | 经理工作台：首页“经理”→ m1 落在对话、控制台页签挂待处理数 → 输入框写一句不发 → 切控制台、工作线、概览再回对话，草稿还在 → “⋯”更新记号与重置确认，取消后提示仍在，确认后提示消失且草稿保留 → 工作线页签点一条线 → 副标题“↰ 经理名”回到经理的工作线页签 | 320×640 |
| `mock/20-manager-keyboard` | 键盘打开时填写决策并直接提交、回答“请你做”、在讨论抽屉与全屏讨论里追问，再切主对话填写；检查页签、输入框和提交按钮 | 未计时 |
| `mock/21-form-keyboard` | 添加设备的数字端口、多行私钥收起键盘；生成钥匙并确认本地保存；口令输入后首次点击导入触发校验；长任务表单输入时直接保存 | 未计时 |
| `mock/22-tools-keyboard` | 终端键盘弹出后补键条与标题可见，收起后恢复；消息编辑弹窗内输入后直接发送 | 未计时 |
| `mock/23-settings-keyboard` | 设备设置数字输入、目录浏览输入与选择、添加工作区的路径和名称、配对文本输入后首次点击校验 | 未计时 |
| `mock/24-comment-keyboard` | 选取回答文字，在评论弹窗输入后直接提交，草稿评论片出现 | 未计时 |
| `mock/25-discussion-keyboard` | 决策的临时对话、报告与建议的追问，键盘打开时直接发送 | 未计时 |
| `mock/28-manager-chat-scroll` | 长经理对话在列表重进和切页签后保持底部；历史消息锚点在重进、后台新增消息和流式输出后保持；普通看板页签不参与对话恢复 | Android / iOS |
| `mock/31-pending-keyboard` | 两道异步提问，聚焦选项下的自填框，键盘打开时断言文字可见 | Android / iOS |
| `mock/32-question-keyboard` | 三题向导展开自填框，键盘打开时输入并断言文字可见，再填下一题；审批拒绝说明自动聚焦。首个可见性断言之前不收键盘 | Android / iOS |
| `fixture/01-home` | 夹具：首页列出设备，设备详情里 8 个 harness、Pi 就绪 → 会话列表 | 14 秒 |
| `fixture/02-new-session` | 新建会话发第一句，收到假模型一段段发来的回答 | 17 秒 |
| `fixture/03-tools` | 建在备好的 git 仓库里 → 终端敲命令真在远端跑了（入口脚本在电脑这边看文件）→ 差异的文件列表和单文件差异 → 文件页打开文件 | 72 秒 |
| `fixture/04-add-device` | 真实设备方式从零加设备：手机上生成钥匙 → 首次连接核对主机指纹 → 登录被拒 → 授权 → 检查看到设备服务 → 添加 | 47 秒 |
| `fixture/05-pair-device` | 扫码添加（粘贴配对文本），整条链是真的：入口脚本替桌面端调设备服务的 `litch/pair/start` 出码 → 确认页只读地显示地址 → 添加：一次性钥匙跑真的 pair-enroll，手机上的确认码和设备服务给的一样 → `litch/pair/decide` 允许 → 不问指纹直接检查、添加进会话列表，设备服务列出这部手机 → 移除（勾着撤钥匙）：钥匙行没了、设备服务也查不到 | 约 90 秒 |
| `fixture/06-sign-in-approval` | 手机批准电脑上的代理登录：扫码时码里带 `a`、手机登记带上批准公钥 → 新建会话 → 入口脚本演桌面端（声明 `clientApprovals` 的连接）在会话上挂登录卡片 → 换第二个账号批准、系统验证框输入锁屏密码（入口脚本给模拟器设的 1111，收尾清掉）→ 用扫码时记下的批准公钥验签、核对账号，卡片收掉；再挂一张拒绝 → 设置里的指纹对得上 → 移除设备撤钥匙 | 约 140 秒 |

带 `smoke` 标签的是 mock 的 01–03 和 fixture 的 01–03。

本机（M 系列芯片，模拟器 `-gpu host`）冷启动整轮实测（不含打包）：全部 9 个约 4 分 55 秒（起模拟器 15 秒、装包 4 秒、夹具 5 秒、流程 4 分 31 秒）；
`--tags smoke` 的 6 个约 2 分 50 秒。

在 GitHub Actions 上（估计，没实跑）：要 ubuntu 加 KVM 的模拟器（GitHub 的 macOS 跑机不能嵌套虚拟化，起不了安卓模拟器），
`-gpu swiftshader_indirect`（入口脚本在非 macOS 上默认用它），流程会慢一些。release 包从零打要 10–20 分钟（gradle 加 gomobile，缓存了 gradle 能省一半）；
模拟器开机 1–2 分钟，Maestro 安装半分钟，夹具的流程另外要 Go 构建适配器（`npm run build`）。所以带打包的一轮大致 20–30 分钟。

要的环境：

- 安卓 SDK（`ANDROID_HOME`，默认 `~/Library/Android/sdk`）和一个 API 35 的 AVD。
- JDK 17 以上（`JAVA_HOME`）：Maestro 和 gradle 都要。
- Maestro 2.3.0：`curl -fsSL "https://get.maestro.mobile.dev" | MAESTRO_VERSION=2.3.0 bash`，或者从
  `https://github.com/mobile-dev-inc/maestro/releases/tag/cli-2.3.0` 下 `maestro.zip` 解开；不在 PATH 里时用 `MAESTRO` 指过去。
- release 包：`--build` 现打（`expo prebuild --clean` 加 `assembleRelease`，本机 M 系列芯片从零 4 分 40 秒左右，要 Go 和 NDK，gomobile 在构建里现编）；
  或者先自己打好，默认取 `android/app/build/outputs/apk/release/app-release.apk`。
- 夹具的流程要先在仓库根目录 `npm run build`（适配器、Pi、设备进程）和 `npm ci --prefix packages/pi`；要 `/usr/sbin/sshd`。不要真的 codex，
  不碰 `~/.codex`、`~/.claude`、用户自己的 ssh 配置。

CI 上的模拟器（reactivecircus/android-emulator-runner 的默认配置）和本地的 `tyrs_hand_e2e_api35` 有两处不一样：
屏幕是 320×640、160dpi，比本地小得多；**没有硬键盘**（本地那台 `hw.keyboard=yes`），软键盘会在焦点回到输入框时自己弹出来。
本地加 `--screen 320x640@160` 只能复现前一条；要和 CI 一模一样，用默认配置新建一台再 `--avd` 指过去：

```sh
echo no | avdmanager create avd -n <名字> --package 'system-images;android-35;google_apis;arm64-v8a'
```

流程里要点的东西先滚到看得见（`scrollUntilVisible`），不假定一屏放得下；但回合结束后的状态行、回答这些“该在底部”的，
直接等它出现、不滚动：对话区贴底是要守住的行为。别在键盘不一定弹着的地方用 Maestro 的 `hideKeyboard`：
它不管有没有键盘都按返回，没弹时会退出当前页。

需要明确收键盘的输入流程共用 `_shared/dismiss-keyboard.yaml`：Android 用系统返回，iOS 点应用的“完成”（包括数字和多行键盘）。
避让回归还要在键盘保持打开时直接点提交；先收键盘再点按钮不能证明避让或首次点击有效。

小屏幕和没有硬键盘的设备上发现、已经修掉的产品问题（流程直接守着，不再绕开）：

- 对话区回合结束时离开底部：回答比一屏长时，回合一结束就停在回答开头，状态行在下面（事实：320×640 上稳定复现，
  有没有请求卡片都一样，卡片只是让回答更长）。原因：尾巴（正在流式的回答）在倒置列表的表头里，回合结束时并回列表数据，
  FlashList 的“保持可见位置”只看行的位置、不管表头同时缩了多少，按并进来的行高把列表推开，而且不发滚动事件
  （`src/detail/Transcript.tsx`）。修法：贴底时列表数据要变之前调一次 `prepareForLayoutAnimationRender()`，这一次不校正。
  守着它的：`mock/03`、`mock/04`、`mock/05` 的结尾直接等状态行。
- `Prompt`（`src/ui/kit/overlays.tsx`，“其他目录”、各处改名用它）开着自动纠错和首字母大写，Gboard 把 `…/s/work` 改成了 `…/s/works `。
  已关掉。`fixture/03` 又改回在“其他目录”里敲路径建会话（终端写的文件要落在那个目录里），但它守不住这一条：
  Maestro 敲的字不经过 Gboard 的纠错，修之前的包上也能过（事实）；当初被改掉，推测是点“确定”时点到了键盘上的空格键。
- 加设备页点“检查”、首次连接的指纹确认框点“信任”之后，焦点回到最后填的一栏、软键盘又弹出来，盖住检查结果和按钮
  （没有硬键盘的设备上）。已改成点“检查”时先 `Keyboard.dismiss()`。守着它的：`fixture/04` 点完“信任”直接接着往下走。

几个坑：

- 回合过程收起行的箭头和统计分开显示，`process-head` 的无障碍名称包含统计、不含箭头。子代理流程同时限定这个
  testID、三个子代理和一个失败，并检查明细未展开，不能用带箭头的旧整行文本匹配。
- offer 降成提案后，回合结束会贴底；原因说明在回答和过程收起行上方。先等 `turn-menu` 出现，再向上找
  `proposal:.*:held`，之后向下找开始按钮。M11 增高收起行后，旧流程只向下找会在 320×640 上漏掉说明；
  本机保留 M9、M12、仅撤回 M11 手机收起行的对照包上，旧 offer 流程通过，确认不是提案状态或 testID 丢失。
- `launchApp` 之后立刻发的测试链接会丢（JS 还没挂上监听），所以 `fresh.yaml` 先等首页出来再发。
- `litch://new` 不等设备连上，夹具刚列出设备时发会落空：夹具的流程走界面新建会话，或者先等设备那一行写着“已连接”。
- CI 的模拟器偶尔掉线一下（Maestro 打出 `device offline`），正跑着的流程会挂，`adb reverse` 的映射也全没了、
  后面的夹具流程都连不上 127.0.0.1:8765。入口脚本跑的时候每两秒看一眼映射、少了就补；只有上文限定的启动失败才恢复并重跑一次。
  本地用 `adb -s <序列号> reconnect` 能复现。最常掉在 `launchApp` 清完数据、停应用那一下（Maestro 驱动刚起来时多），
  流程报 Unable to launch app，本地仿 CI 的模拟器上也有；不再在 `fresh.yaml` 内重试，保留首次失败。
- 重跑时上一轮可能把锁屏密码设着没清（流程半路挂了），入口脚本的 `/lock/pin` 已经设过就不再设；
  扫码绑好的手机也可能没移除，`/pair` 出码前先撤掉设备上已绑定的手机，05、06 收尾“一部都不剩”才验得准。
- xterm 的内容读屏读不到：终端里的命令跑没跑，由入口脚本开在回环上的小口去看工作目录里的文件（`_shared/wait-file.js`）。
- 入口脚本不能用同步的方式起 Maestro：流程里的 `runScript` 要连同一个进程里的小口。
- 同一台电脑上同时只能跑一个 Maestro：2.3.0 在安卓上把驱动固定映射到电脑的 7001 口、没有参数能改，第二个会在启动应用时超时。
  入口脚本开头先看 7001 有没有被占，被占就直接报错。换 `--port` 只能让模拟器不撞，躲不开这一条。

## 审核前专项

Release E2E 构建使用 `EXPO_PUBLIC_LITCH_E2E=1`，发布包为 `0`；不要仅用 `__DEV__` 判断。
`scripts/e2e.mjs --build` 自动设置验收开关，iOS `LITCH_MOBILE_DEV=1 scripts/build-ios.sh` 同样设置。
Android 执行器及 CI 从 APK 的 `assets/app.config` 核对档位；release/非 debuggable 本身不能证明入口已关闭。
Android 换源正测 `mock/33-update-links.yaml` 随默认全集运行：假更新源确实收到请求、横条出现且重启后仍有效，
没有点击下载就不能请求 APK。它只适用于 Android；iOS 不提供 APK 更新。
发布包负测需单独构建（两步均传 `EXPO_PUBLIC_LITCH_E2E=0`：`expo prebuild` 与 `npm run android:release`），运行：

```sh
node scripts/e2e.mjs --apk /绝对路径/发布包.apk --only e2e/flows/production/android-dev-links.yaml
```

负测覆盖冷/热启动的 `litch://update?feed=`、mock/fixture 启动和 remote 参数链接；必须保持真实设备首页，
开发设置隐藏，且宿主假更新源的请求数为 **0**。执行器保留 `update-link.json` 和 Maestro JUnit，
用 `LITCH_E2E_ARTIFACTS` 指定持久证据目录；不靠更新横条缺失推断无网络副作用。

普通流程的执行器在遇到数据同意卡时显式点击“同意并继续”，然后仍执行原产品断言；
带 `privacy` 标签的专项流程不自动同意，验证取消、允许、撤回与登录前披露。
等待元素消失（例如发送后草稿清空）也会在有界轮询中处理同意卡，不重复发送操作，
最终仍执行完整的原选择器和断言。25 号流程首次讨论发送显式要求同意框出现并点击允许，
用于发现讨论抽屉打开时同意框无法显示或无法点击的问题。

`e2e/ios/DiscussionConsentTests.swift` 使用独立 XCUITest 检查讨论内同意、取消保留草稿、
允许后消息出现且输入清空，以及关闭抽屉后主输入框的同意。先在专用模拟器卸载、重装
Litch Dev 验收包，保证没有已保存的同意记录；使用模拟核心，不连接真实模型。
用 `scripts/ios-test-project.rb` 生成独立测试工程，在 iPhone 和 iPad 各跑一次，
结束立即关闭模拟器。XCUITest 不使用 Maestro 的 7001 端口。

- `mock/29-review-privacy.yaml`：新建取消不发送、允许后继续、撤回后再问、Tailscale 取消。
- `scripts/check-review-production.mjs <专用模拟器> <发布 .app 绝对路径>`：持有 Maestro 7001 共享锁，
  向隔离应用种入旧开发配置后运行 `production/review-links.yaml`，验证正式 Bundle ID 的深链无效、
  开发设置隐藏、旧配置清理；结束关闭该专用模拟器。只能用 `Litch-iOS-Review` 前缀的模拟器。
- `scripts/check-ios-terminal.mjs`：原有字符/中文/粘贴/旋转用例，以及 `testColdStartKeyboard`。
- `scripts/audit-ios-review.mjs <.app> [--e2e]`：检查包内构建档位与所有原生主程序/framework。

## iOS 图片附件

`ios/images.yaml` 在系统照片选择器中选取 JPEG、HEIC、PNG，验证菜单关闭后相册保持可见、
取消后可重新打开、三张图进入草稿、原生文件选择器取消后保留图片，以及发送后草稿清空和消息出现。
它只使用模拟核心，启动时明确拒绝系统权限，防止 Maestro 默认全部授予掩盖照片权限问题。
`image-fixtures.swift` 生成三张小色块；导入后应为照片库最新的三张。
没有直接拍照入口，不把模拟器照片选择验收记作真机相机验收。

先以 `LITCH_MOBILE_DEV=1 bash scripts/build-ios.sh` 构建，再用专用 `Litch-iOS-` 模拟器运行：

```sh
# 在 apps/mobile 执行，IOS_IMAGE_SIM 指向专用模拟器的 UDID。
(
  set -e
  trap 'xcrun simctl shutdown "$IOS_IMAGE_SIM"' EXIT
  mkdir -p .artifacts/ios-images
  xcrun swift e2e/ios/image-fixtures.swift .artifacts/ios-images
  xcrun simctl boot "$IOS_IMAGE_SIM"
  xcrun simctl bootstatus "$IOS_IMAGE_SIM" -b
  xcrun simctl install "$IOS_IMAGE_SIM" ios/build/Build/Products/Release-iphonesimulator/LitchDev.app
  xcrun simctl addmedia "$IOS_IMAGE_SIM" .artifacts/ios-images/fixture.png .artifacts/ios-images/fixture.heic .artifacts/ios-images/fixture.jpg
  node scripts/check-tablet.mjs "$IOS_IMAGE_SIM" ios/images.yaml
)
```

执行器持有共享 `/tmp/litch-maestro-7001.lock`，不会绕过其他验收。可用 `MAESTRO` 指定 CLI；
`LITCH_TABLET_SCREENSHOTS` 指定保留截图的绝对目录。此流程按 iOS 26 的照片选择器无障碍标识选择图片；
其他 iOS 版本若标识改变需核对真实界面，不能以点击坐标或删断言让流程通过。

## 平板与窗口变化

`e2e/ios/QuestionKeyboardTests.swift` 用独立 XCUITest 验提问、多行输入、审批说明和异步提问。
它用 `app.typeText` 输入，避免 XCTest 替应用滚动字段；断言完整输入框边界在所属卡片视口内，下沿不越过键盘上沿。
只在已安装本分支 Litch Dev 验收包的专用模拟器上运行，不占 Maestro 7001。可复用固定版本的 `scripts/ios-test-project.rb`
生成测试工程（第三个参数用 `app.json` 作资源即可），再以 `-parallel-testing-enabled NO` 指定该模拟器跑 `TerminalTests` scheme。
测试只用 mock；异步提问从初始空闲的 s3 发起，不能用仍在演示回合中、会把新消息当插话的 s1。

`node scripts/check-tablet.mjs <模拟器标识> tablet/navigation.yaml tablet/window.yaml` 只接受
`litch_` AVD 和 `Litch-iOS-` iOS 模拟器，使用模拟核心、共享 Maestro 7001 锁，退出删除临时报告。
iOS 安装开发包 `dev.litch.app.dev`，Android 安装普通包。两端都不使用真实设备或模型。

- `navigation.yaml`：两栏选择会话、输入草稿、横竖旋转、浏览左侧目录、打开第三栏终端。
- `window.yaml`：关闭工具栏，验证对话和草稿仍在；三个标题栏的返回键按栏命名，不能按位置序号点击。
- `narrow.yaml` / `wide.yaml`：宿主先真实调整系统窗口，再分别验证退回单栏和展开两栏，草稿必须仍在。
- 断点单测在 `test/tablet-layout.test.mjs`：840 点展开 240–300 点侧栏；1280 点且工具打开才显示 380 点第三栏。

Android 平板 AVD 使用自然横屏 1280×800、160 dpi；Maestro 的 `PORTRAIT` 指自然方向，
执行器在复制流程时将方向占位符转为各自枚举。自由窗口验收可在专用 AVD 上启用
`settings put global enable_freeform_support 1`，用 `am start --windowingMode 5` 打开当前应用，
从 `dumpsys activity activities` 取得任务号，再以 `am task resize` 调整窗口；
恢复全屏用 `am start --windowingMode 1`。这测试系统分配的真实窗口，不改 JS 尺寸。

同一执行器可以跑 `flows/mock/01-home.yaml`、`02-new-session.yaml`、`03-approvals.yaml`、
`19-manager-workbench.yaml` 等手机回归。iOS 仅转换包名、深链确认、键盘完成按钮和系统返回操作，
保留产品断言。平板流程独立于默认手机流程集合。

`tablet/files.yaml` 验文件第三栏，`tablet/manager.yaml` 验经理目录与工作台并排及页签草稿；
`tablet/keyboard-prepare.yaml` 准备硬件按键测试，`tablet/store.yaml` 保存纯模拟数据的 iPad 竖屏素材。
设 `LITCH_TABLET_SCREENSHOTS` 为输出绝对目录可保留素材；默认写到临时目录并清理。

iPadOS 26.5 模拟器拖动右下角系统把手可以进入真实自由窗口（`tablet/ios-narrow.yaml`）。
当前 Maestro/Simulator 在此状态没有返回应用的无障碍节点，`narrow.yaml` 的自动断言未通过；
不能把截图人工确认当作 Maestro 通过。恢复全屏后节点恢复。外接键盘的 iOS 合成事件同样
需区分输入工具与产品：本机 `typeKey` 的 Command+A 无效，不能据其结果确认真实键盘行为。
Android 可用 `adb shell input keycombination 59 66` 验 Shift+Enter，再以 `input keyevent 66` 验发送；
必须核对多行输入和消息正文，不只检查输入框变空。
