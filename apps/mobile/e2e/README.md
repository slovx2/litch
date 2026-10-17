# 移动端的自动化用例

两组：单元测试（纯逻辑，秒级，不要模拟器）和端到端（安卓模拟器上的 release 包，Maestro 驱动）。

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
- 本机实测：51 条，约 3 秒。

## 端到端

```sh
cd apps/mobile && npm run e2e -- [--build] [--only mock|fixture|<流程文件>] [--tags smoke] [--keep]
```

入口 `scripts/e2e.mjs`：不给 `--serial` 就在 `--port`（默认 5590）上无窗口、只读地起一台（默认 AVD `tyrs_hand_e2e_api35`）；
那个端口上已经有设备（不管什么状态）就报错，让你换 `--port` 或者用 `--serial` 指定，不拿别人的来用。
然后装包，要夹具的流程先起夹具（`scripts/fixture.mjs`，真的适配器经 SSH、隔离的 Pi、回环上的假模型），跑完收尾：
停夹具、只撤夹具加的那两条 `adb reverse`、关掉自己起的模拟器（`--serial` 给的不关）、删临时目录。有流程没过返回非零；
Ctrl-C 打断时照样收完尾，退出码 130。

Maestro 的调试输出（失败时的截图、日志）默认放在临时目录里、跑完删掉（`--keep` 才留下）；设了 `LITCH_E2E_ARTIFACTS=<目录>`
就放到那个目录并留着，CI 上失败时上传它。

流程在 `flows/`，靠测试链接和 testID 驱动，不点坐标；每个流程开头清掉应用数据（`_shared/fresh.yaml`），互不依赖、可以单跑。

| 流程 | 走的路径 | 本机耗时 |
|---|---|---|
| `mock/01-home` | 模拟核心：首页四台设备 → 会话列表 | 6 秒 |
| `mock/02-new-session` | 新建会话页发第一句 → 详情页收到流式回答、回合结束 | 18 秒 |
| `mock/03-approvals` | 等审批的会话：命令审批、MCP 工具审批一张张答完 | 12 秒 |
| `mock/04-question-form` | 三道题的提问（单选、自己写、单选）→ MCP 表单填完交上 | 28 秒 |
| `mock/05-plan` | 计划模式：Claude Code 自己问要不要执行；只有 codex 的设备上界面来问，点“执行” | 49–53 秒 |
| `fixture/01-home` | 夹具：首页列出设备，设备详情里 8 个 harness、Pi 就绪 → 会话列表 | 14 秒 |
| `fixture/02-new-session` | 新建会话发第一句，收到假模型一段段发来的回答 | 17 秒 |
| `fixture/03-tools` | 建在备好的 git 仓库里 → 终端敲命令真在远端跑了（入口脚本在电脑这边看文件）→ 差异的文件列表和单文件差异 → 文件页打开文件 | 72 秒 |
| `fixture/04-add-device` | 真实设备方式从零加设备：手机上生成钥匙 → 首次连接核对主机指纹 → 登录被拒 → 授权 → 检查看到设备服务 → 添加 | 47 秒 |

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

CI 上的模拟器（reactivecircus/android-emulator-runner 的默认配置）屏幕是 320×640、160dpi，比本地小得多：
本地要复现就加 `--screen 320x640@160`。流程里要点的、要看的东西一律先滚到看得见（`scrollUntilVisible`），不假定一屏放得下。

发现的产品问题（事实：在 320×640 上稳定复现；1080×2400 上回答一屏放得下，看不出来）：

- 会话停在请求卡片上（提问、表单、计划要不要执行）时，答完卡片、回答写完之后，对话区不再贴底：屏幕上停在回答的开头，
  状态行和回答的后半截在下面，要手动往上划才看得到。没有卡片时同样长的对话是贴底的。
  推测和卡片撤掉时对话区变高、列表一直开着的“保持可见位置”有关，没有查到根因。`mock/04`、`mock/05` 的结尾因此是往下滚着找状态行。
- 一行字的输入框（`src/ui/kit/overlays.tsx` 的 `Prompt`，新建会话页的“其他目录”、改名都用它）没关自动纠错和首字母大写：
  在 Gboard 上输入路径 `…/s/work` 被改成了 `…/s/works `。填目录的地方应该关掉（`autoCorrect={false}`、`autoCapitalize="none"`）。
  `fixture/03` 因此不在那里填目录，改用测试链接建会话。

几个坑：

- `launchApp` 之后立刻发的测试链接会丢（JS 还没挂上监听），所以 `fresh.yaml` 先等首页出来再发。
- `litch://new` 不等设备连上，夹具刚列出设备时发会落空：用它之前先等设备那一行写着“已连接”。
- xterm 的内容读屏读不到：终端里的命令跑没跑，由入口脚本开在回环上的小口去看工作目录里的文件（`_shared/wait-file.js`）。
- 入口脚本不能用同步的方式起 Maestro：流程里的 `runScript` 要连同一个进程里的小口。
- 同一台电脑上同时只能跑一个 Maestro：2.3.0 在安卓上把驱动固定映射到电脑的 7001 口、没有参数能改，第二个会在启动应用时超时。
  入口脚本开头先看 7001 有没有被占，被占就直接报错。换 `--port` 只能让模拟器不撞，躲不开这一条。
