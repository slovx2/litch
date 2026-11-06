# Chrome 自动验收

在 macOS、Node 24、Go 环境运行：

```sh
npm run client:check:chrome
```

加 `-- --no-evidence` 不写截图、报告或浏览器日志，结束后只保留终端验收结果。生命周期场景使用隐藏 Electron 窗口中的正式 Chrome 桥与执行器：网站审批实际等待 31 秒，重启隔离 Chrome、重启 Electron 宿主、更换隔离扩展副本/profile；同一会话不出现实例或标签审批。扩展停止控制在两端重启后仍生效，只能通过扩展工具栏的用户回调恢复。自动验收只在临时扩展副本捕获该回调，发布扩展没有测试入口。

输入场景同时跑默认 headless 和 headed CFT 最小化窗口，后者以 `--no-startup-window` 启动，显式创建 `windowState:minimized` 的隔离窗口并在每项检查后核对未恢复显示；新建工具标签仍为 `active:false`。覆盖点击/焦点/字段回读、同源导航、SPA 延迟提交、同值输入、批量中途失败及签名 URL/验证码脱敏。`focus-probe.mjs` 是独立因果对照：交替关闭/开启焦点模拟，各用全新最小化页面，记录并断言按钮计数及逐次 Tab 焦点。它不用用户资料、不激活日用窗口，不保留截图或报告。

设置页安装引导另跑 `node scripts/chrome-e2e/settings.mjs`：隔离 HOME 中启动隐藏 Electron，加载正式 ChromeSection 和模拟设置通道，点击商店/手动入口，覆盖自动连接、聚焦刷新、失败重试、过期状态回包、版本不兼容及三平台中英文/三皮肤布局。要求根目录、界面和桌面依赖已安装，Electron 二进制已准备好；不接个人 Chrome、不打开真实商店，不保留截图或报告。宿主准备与打开商店的顺序由 `chrome-install.test.mts` 核对；这两项不能代替商店发布后的签名扩展安装验收。

可用 `LITCH_CHROME_GO=/绝对路径/bin/go` 选择本机已安装、满足 go.mod 的 Go 工具链，避免隔离 HOME 再下载工具链；不改变隔离模块缓存和浏览器 profile。

标签组/活动标记验收包括临时认领原组与固定标签、同会话归组、活动与异常恢复、扩展 reload、worker 强停、桥断线和停止控制后的日志清理。批量验收包括连续点击、失败停步、重复 callId 不重放、逐步来源拒绝和执行中撤租约；保留每步摘要和最后快照。辅助场景在 `ux.mjs`。

脚本从源码构建固定 ID 的未打包扩展和 Native Messaging Go 宿主，默认使用本机 Playwright 缓存中的 Chrome for Testing。也可显式设置 `LITCH_CHROME_BINARY` 为已安装的 Chrome for Testing 可执行文件。桌面构建依赖缺失时按锁文件运行 `npm ci --ignore-scripts`；没有现成 CFT 时下载固定版本 151.0.7922.34 到工作树 `.local/chrome-e2e-bootstrap/`。不会使用日用 Chrome。准备时间单独计入总耗时。

自动验收一律使用 Chrome for Testing，通过 `--load-extension` 加载未打包扩展，并用 CDP 在隔离的 `chrome://extensions` 开启开发者模式。没有开启开发者模式时 Chrome 会在 reload 后禁用未打包扩展，验收不跳过这一步。不使用系统级鼠标、键盘或 AX 操作安装界面；每次连接 CDP 前核对监听 PID 与本次启动参数中的隔离 user-data-dir。

每次创建独立的 HOME、CODEX_HOME、user-data-dir 和 NativeMessagingHosts。浏览器使用 mock keychain / basic password store；不读取个人模型凭据，不访问真实钥匙串。端口动态选择并核对监听 PID，禁止 9333。成功失败都终止浏览器、断开宿主、清理临时目录。退出码非零表示失败，报告与截图按每次运行分别保存在 `.local/chrome-e2e/<时间>-<PID>/`，根目录的 `report.json` 指明最近一次的结果与路径，避免并行运行覆盖证据。

场景用回环 HTTP 夹具提供登录 Cookie、弹窗、跨来源 iframe 和输入控件；操作经正式 `ChromeExecutor → ChromeBridge → Go Native Messaging → MV3` 路径，审批由脚本答复。CDP 只用于验收侧检查 PID、改变缩放和触发扩展生命周期，不替代模型业务工具。脚本化的 remote invocation 只验证控制端语义，不能代替真实 SSH 设备验收。

默认主要场景为 headless，生命周期输入使用最小化窗口。获准前台验收后加 `--focus-windows`，`background-check.mjs` 会短暂打开两个隔离 headed 窗口，在 navigate、newTab、claim、click、type、run_actions 和登录卡等待前后核对所有窗口焦点及活动标签，并监听中途激活事件；显式 show 是对照组。结束后关闭隔离窗口，不操作日用 Chrome。运行 `LITCH_CHROME_GUI_SLOT=approved npm run client:check:chrome -- --no-evidence --focus-windows` 可完整执行上述场景。如果要观看主要场景，获准前台时段后运行：

```sh
LITCH_CHROME_GUI_SLOT=approved npm run client:check:chrome -- --shown
```

正式版 Chrome 的开发者模式与“加载已解压的扩展程序”由用户最后人工验收；系统目录选择框不以系统输入自动化代替。DevTools UI、正式 Chrome 光标观感与 Litch 设置页视觉验收是单独的有窗口项目。正式版不支持命令行自动加载未打包扩展，不能用这条脚本宣称已验证其安装引导。排队取得前台后仍只操作隔离实例，不激活、截图或读取日用 Chrome。


已安排真实隔离远程设备时，额外设置 `LITCH_SSH_CONFIG`、`LITCH_REMOTE_ADAPTER`、`LITCH_REMOTE_CODEX`（指不存在的隔离路径）、`LITCH_CHROME_REMOTE_ALIAS`，再传 `--remote`。脚本不会自行修改远端安装、SSH 配置或服务；这些必须事先由负责该设备的会话准备。此项使用真实核心、SSH、远端 Pi 和回环假模型，审批通过核心 session.respond，浏览器仍在控制端。

`remote-model.mjs` 是共享隔离假模型。测试提示为 `LITCH_TOOL_PLAN ` 后接步骤数组，每项 `{namespace,tool,args}`（namespace 缺省 litch_browser），`args` 的 `$targetId` / `$tabId` 可引用先前工具结果。最终回话带 `LITCH_REMOTE_DONE`。它只在显式指定的 `/opt/litch-chrome` 与隔离 HOME 启动。

测试退出会停止本次 Chrome 与原生桥并删除 profile。远程服务与假模型属于两条工作线共用的预置夹具，`--remote` 只断开自己的会话连接，不擅自停止或删除它们；负责共享夹具的会话在各线验收后统一拆除。
