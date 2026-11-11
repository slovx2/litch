# Chrome 自动验收

局部后台输入回归：`node scripts/chrome-e2e/background-input.mjs --expect-fixed`。只构建扩展与原生桥，不跑 Full；默认使用最小化隔离 CFT，检查后台标签、首次认领、导航、登录暂停/交还后重新认领，以及页面 rAF 和指针 world 的 rAF/计时器不回调。每次打印完整回执、页面值及窗口状态，退出清理 profile、浏览器、桥和站点夹具。冻结命令的结果以报告中的 `tab.frozen` 为准，不能把发出了命令等同于 Chrome 真的冻结。

`--cases=minimized-active-sequence --expect-fixed` 单独运行最小化活动标签回归：连续五轮各用新窗口，fixture 保持活动，依次 navigate、newTab、click、重新 snapshot、type；不重试输入。断言输入回执、字段值及点击计数，每一步核对活动标签未切换、窗口仍最小化，并监听中途激活事件和 NSWorkspace 前台变化。新场景也包含在默认局部验收中。

获准使用隔离可见窗口后，可运行 `LITCH_CHROME_GUI_SLOT=approved node scripts/chrome-e2e/background-input.mjs --shown --expect-fixed`，增加前台和完全遮挡对照；通过 CGWindowList 的顺序和边框包含关系确认覆盖，不读取用户窗口。`LITCH_CHROME_EXTENSION_SOURCE` 可指向历史版本的源码导出目录（保留 `apps/desktop/scripts/build-chrome.mjs` 及其依赖），`LITCH_CHROME_DRIVER_SOURCE` 可指向历史执行器源码；只用于复现前后对照，不修改或安装用户扩展。需要本机 Node 24、Go 和桌面构建依赖。

在 macOS、Node 24、Go 环境运行：

```sh
npm run client:check:chrome
```

远程上传可用 `npm run client:check:chrome -- --headless-only` 验收，假远程走正式设备读取、核心反向 IPC 与主进程暂存，清理后再做 FileReader 和实际表单提交。内置浏览器对应 `npm --prefix apps/desktop run check:remote-upload`：99 MiB 源文件经过同一条完整链路，并报告渲染进程工作集峰值、用时及页面心跳。两者都不建立 SSH 或访问真实 Chrome 配置。

只需要 headless 定向验收时用 `npm run client:check:chrome -- --headless-only`，仍跑正式 executor、上传、权限、输入和回执检查，但不启动额外的 headed 生命周期/最小化窗口场景。报告将 `headedLifecycle` 标为 `notRequested`；默认完整验收及其前台应用不变断言保持原样。

上传验收在隔离 profile 对照 `isAllowedFileSchemeAccess()` 关/开/关时旧 CDP 上传的确切结果，并读取该版本的扩展详情 UI。正式 `upload` 在关闭权限时上传小文件、空文件、129 MiB 文件及拖放区域/同源 iframe；本地接收服务器逐文件核对字节数、SHA-256、名称、MIME、修改时间和事件顺序。还覆盖分块中撤租约、导航及 512 MiB 总量/单文件上限。报告的 `upload` 字段保留根因对照与接收结果。这里的 `.mp4` 是确定性测试字节，不证明视频网站会接受其媒体格式，也不代替商店签名扩展或真实投稿验收。

加 `-- --no-evidence` 不写截图、报告或浏览器日志，结束后只保留终端验收结果。生命周期场景使用隐藏 Electron 窗口中的正式 Chrome 桥与执行器：网站审批实际等待 31 秒，重启隔离 Chrome、重启 Electron 宿主、更换隔离扩展副本/profile；同一会话不出现实例或标签审批。扩展停止控制在两端重启后仍生效，只能通过扩展工具栏的用户回调恢复。自动验收只在临时扩展副本捕获该回调，发布扩展没有测试入口。

输入场景同时跑默认 headless 和 headed CFT 最小化窗口，后者以 `--no-startup-window` 启动，显式创建 `windowState:minimized` 的隔离窗口并在每项检查后核对未恢复显示；新建工具标签仍为 `active:false`。覆盖点击/焦点/字段回读、同源导航、SPA 延迟提交、同值输入、批量中途失败及签名 URL/验证码脱敏。`focus-probe.mjs` 是独立焦点对照：交替关闭/开启焦点模拟，各用全新最小化页面，记录按钮计数及逐次 Tab 焦点，开启模拟时必须生效。它不用用户资料、不激活日用窗口，不保留截图或报告。

M3 抽包验收默认同时组装并加载第二个测试扩展，用独立 ID/host/token/安装目录验证不改 Litch 登记；已经附着的同一 tab 被拒绝，第一扩展继续工作，第二扩展可控制自己的新 tab。测试扩展只进入本次隔离 profile。

`npm run client:check:chrome -- --race-only` 专门执行 5 轮跨扩展并发认领；`--concurrent-claim` 在完整场景之后执行同一组诊断。两个 worker 先查询真实目标身份，再并发发出 claim；两个原生 host 使用同一隔离锁目录。若双方成功，报告完整 before/after 和结果并退出非零。修复前曾用延迟 getTargets 返回的定向夹具复现 4/5 双成功；修复后跨进程锁单测与真实并发一起验证。

`node scripts/chrome-e2e/compare-extension.mjs <f39ec336导出源码目录>` 从源码重新构建前后产物，输出 `.local/chrome-comparison/report.json` 的逐文件字节数与 SHA-256。`node scripts/chrome-e2e/check-packages.mjs` 构建两个 tarball、在仓外安装并检查无 Electron 的独立消费；产物及哈希在 `.local/chrome-packages/`。普通检查依赖 `client:build` 的新产物，先构建再验。

设置页安装引导另跑 `node scripts/chrome-e2e/settings.mjs`：隔离 HOME 中启动隐藏 Electron，加载正式 ChromeSection 和模拟设置通道，点击商店/手动入口，覆盖自动连接、聚焦刷新、失败重试、过期状态回包、版本不兼容及三平台中英文/三皮肤布局。要求根目录、界面和桌面依赖已安装，Electron 二进制已准备好；不接个人 Chrome、不打开真实商店，不保留截图或报告。宿主准备与打开商店的顺序由 `chrome-install.test.mts` 核对；这两项不能代替商店发布后的签名扩展安装验收。

可用 `LITCH_CHROME_GO=/绝对路径/bin/go` 选择本机已安装、满足 go.mod 的 Go 工具链，避免隔离 HOME 再下载工具链；不改变隔离模块缓存和浏览器 profile。

标签组/活动标记验收包括临时认领原组与固定标签、同会话归组、活动与异常恢复、扩展 reload、worker 强停、桥断线和停止控制后的日志清理。批量验收包括连续点击、失败停步、重复 callId 不重放、逐步来源拒绝和执行中撤租约；保留每步摘要和最后快照。辅助场景在 `ux.mjs`。

脚本从源码构建固定 ID 的未打包扩展和 Native Messaging Go 宿主，默认使用本机 Playwright 缓存中的 Chrome for Testing。也可显式设置 `LITCH_CHROME_BINARY` 为已安装的 Chrome for Testing 可执行文件。桌面构建依赖缺失时按锁文件运行 `npm ci --ignore-scripts`；没有现成 CFT 时下载固定版本 151.0.7922.34 到工作树 `.local/chrome-e2e-bootstrap/`。不会使用日用 Chrome。准备时间单独计入总耗时。

自动验收一律使用 Chrome for Testing，通过 `--load-extension` 加载未打包扩展，并用 CDP 在隔离的 `chrome://extensions` 开启开发者模式。没有开启开发者模式时 Chrome 会在 reload 后禁用未打包扩展，验收不跳过这一步。不使用系统级鼠标、键盘或 AX 操作安装界面；每次连接 CDP 前核对监听 PID 与本次启动参数中的隔离 user-data-dir。

每次创建独立的 HOME、CODEX_HOME、user-data-dir 和 NativeMessagingHosts。浏览器使用 mock keychain / basic password store；不读取个人模型凭据，不访问真实钥匙串。端口动态选择并核对监听 PID，禁止 9333。成功失败都终止浏览器、断开宿主、清理临时目录。退出码非零表示失败，报告与截图按每次运行分别保存在 `.local/chrome-e2e/<时间>-<PID>/`，根目录的 `report.json` 指明最近一次的结果与路径，避免并行运行覆盖证据。

场景用回环 HTTP 夹具提供登录 Cookie、弹窗、跨来源 iframe 和输入控件；操作经正式 `ChromeExecutor → ChromeBridge → Go Native Messaging → MV3` 路径，审批由脚本答复。CDP 只用于验收侧检查 PID、改变缩放和触发扩展生命周期，不替代模型业务工具。脚本化的 remote invocation 只验证控制端语义，不能代替真实 SSH 设备验收。

默认主要场景为 headless，生命周期输入使用最小化窗口。加 `--focus-windows` 会执行双后台窗口场景：两个窗口均保持最小化，参考窗口只使用 Chrome 内部的活动标签，不获取 macOS 前台。在 navigate、newTab、claim、click、type、run_actions 和登录卡等待前后核对窗口及活动标签，并监听中途激活事件。无打扰验收不执行 `show`，因为该工具本来就会激活系统窗口。

双窗口场景还核对 `tabs(action:list)` 的每项 `current` 与扩展 `getLastFocused` / `tab.active` 的只读状态一致，列举前后及期间窗口、活动标签和系统前台均不变；终端输出 `CURRENT_TAB_EVIDENCE`，仅含隔离夹具的标题、网址和标记。

headed CFT 经 `open -g -n -W` 后台启动，显式等待窗口最小化；隐藏 Electron 宿主禁止参与应用激活。不用 `open -j` 隐藏整个应用，避免把应用隐藏和窗口最小化混为一种验收条件。Swift `NSWorkspace.frontmostApplication` 监视器在整个 headed 生命周期记录激活通知并每 20ms 采样，逐步及退出后检查用户前台应用 PID 没有变化，不在事后恢复焦点掩盖切换。双窗口验收不需要前台时段：`npm run client:check:chrome -- --no-evidence --focus-windows`。不要与其他会切换应用的验收并行，用户自行换应用也会明确报错。独立 `focus-probe.mjs` 同样使用后台启动与监视器；关闭模拟的对照记录实际结果，不强制要求不同系统焦点条件都丢输入。

如果需要观看主要场景，仍须获准前台时段后显式运行：

```sh
LITCH_CHROME_GUI_SLOT=approved npm run client:check:chrome -- --shown
```

正式版 Chrome 的开发者模式与“加载已解压的扩展程序”由用户最后人工验收；系统目录选择框不以系统输入自动化代替。DevTools UI、正式 Chrome 光标观感与 Litch 设置页视觉验收是单独的有窗口项目。正式版不支持命令行自动加载未打包扩展，不能用这条脚本宣称已验证其安装引导。排队取得前台后仍只操作隔离实例，不激活、截图或读取日用 Chrome。


已安排真实隔离远程设备时，额外设置 `LITCH_SSH_CONFIG`、`LITCH_REMOTE_ADAPTER`、`LITCH_REMOTE_CODEX`（指不存在的隔离路径）、`LITCH_CHROME_REMOTE_ALIAS`，再传 `--remote`。脚本不会自行修改远端安装、SSH 配置或服务；这些必须事先由负责该设备的会话准备。此项使用真实核心、SSH、远端 Pi 和回环假模型，审批通过核心 session.respond，浏览器仍在控制端。

`remote-model.mjs` 是共享隔离假模型。测试提示为 `LITCH_TOOL_PLAN ` 后接步骤数组，每项 `{namespace,tool,args}`（namespace 缺省 litch_browser），`args` 的 `$targetId` / `$tabId` 可引用先前工具结果。最终回话带 `LITCH_REMOTE_DONE`。它只在显式指定的 `/opt/litch-chrome` 与隔离 HOME 启动。

测试退出会停止本次 Chrome 与原生桥并删除 profile。远程服务与假模型属于两条工作线共用的预置夹具，`--remote` 只断开自己的会话连接，不擅自停止或删除它们；负责共享夹具的会话在各线验收后统一拆除。
