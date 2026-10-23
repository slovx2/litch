# 开发约定

本仓库把 Claude Code、Pi 等 harness 接入 Codex app-server 协议（适配器），并在它上面做了桌面客户端 Litch 和移动端。

本文件只写长期有效的原则和去哪里找。某个模块怎么实现、为什么这样做，写在代码注释、包内的 `AGENTS.md` 和测试里，不往这里加。

## 通用

- 用中文写新增注释与维护文档。在当前分支工作。修改分小块进行，每次尽量不超过 300 行。
- TypeScript 用 `.mts`、ESM、可擦除语法（`packages/ui` 要写 JSX，用 `.ts`、`.tsx`）。不手工修改 `dist` 和生成的协议材料。
- 依赖声明与锁文件一律用精确版本。整个仓库只有一个版本号（根目录 `package.json`），`scripts/check-versions.mjs` 会查出没跟上的地方。
- 不写兼容旧数据、旧环境变量的代码：旧的适配数据库直接拒绝，不加持久化标记或路径回退。
- 不从别的应用里搬代码、图标或文案进来。

## 仓库结构

| 位置 | 内容 |
|---|---|
| `cmd/codex-harness-adapter` | Go 命令行：起停各运行时、设置的权威、控制通道、给设备装 harness、伪终端桥。只监听本机 |
| `cmd/claude-process-guard` | Claude 入口夹在它和 CLI 之间的守护进程（Go，各平台都编进 `packages/claude/dist`，见 `scripts/build-process-guard.mjs`） |
| `sshserver` | 通用 Go 库，不依赖上层业务 |
| `packages/claude`、`pi`、`dsh`、`opencode`、`acp` | 并列的引擎（各 harness 的入口），`packages/shared` 只放共享能力 |
| `packages/device` | 设备进程：把本机各运行时收在一个聚合面后面，给我们自己的客户端连 |
| `packages/protocol` | 协议类型与我们自己的扩展定义，设备进程和客户端唯一共用的包 |
| `packages/core` | 客户端核心：通道、数据副本、连接层、投影、模拟核心。纯 TypeScript，平台能力由外壳注入 |
| `packages/ui` | 界面。只用浏览器标准接口，只认核心给的显示数据，能在普通浏览器里对着模拟核心跑 |
| `apps/desktop` | Electron 外壳。主进程只管窗口和牵线，不在数据路径上；渲染进程开沙箱 |
| `apps/mobile` | React Native 移动端，直接用 `packages/core`（`@litch/core`），不另写核心 |

- 客户端和适配器只经协议说话，互不引用代码。
- `packages/device` 没有自己的 `node_modules`，只能引用 `packages/protocol/src/` 下自包含的文件，不能引用 `codex.mts`。
- `packages/ui`、`apps/desktop` 各有自己的依赖清单，包之间用路径别名，不用 npm 工作区。

## 协议与 harness

- 协议扩展只增不改；服务端主动发的扩展内容只发给声明过的连接（按投递到的那条连接算）；名字带自己的前缀；没改过的官方桌面端必须始终能连。扩展定义在 `protocol/extensions/`，改形状要同步改定义和 `packages/protocol/src/` 里的类型。
- 与上游的兼容性由 `npm run test:compat` 守着，出入清单 `protocol/compat/baseline.json` 只许变短。新的出入要改成按声明发，不往清单里加。
- 加 harness：Go 层只在 `harness_table.go` 的登记表里加一行，名字和徽标只写在 `packages/protocol/src/harness-identity.json`。优先接厂商自家界面用的原生接口，单独写引擎包；ACP 只作备选或快速接入。
- 引擎在 `runtime/info` 里自报的能力声明必须如实，改了能力要同步改声明。
- harness 本体不打包、不随仓库分发，只用用户自己装的；接入必需的插件包随适配器分发，用精确版本。
- 对用户装的 harness 只设版本下限，不写死版本。CI 的精确版本在 `protocol/versions.json`，不要写成用户必须装的版本。
- 命令行给人看的提示中英文写在同一处（`tr(中文, 英文)`）。用户终端只输出状态、连接参数和可操作的错误，诊断细节进日志。

## 客户端

- 界面取数据只走通道上的命令和订阅；组件只订阅自己要显示的那个键。
- 样式不写死颜色、字体、圆角、阴影，一律用皮肤变量（`packages/ui/src/styles/skins/`）。
- 界面文字一律 `t('键')`，中英文两份文案；核心不认识语言，只给 `Phrase`。
- 文案书面、简洁，不用口语（这边、那边、用着、接着、就能、一下），不重复，不解释显而易见的事；设置项只留名字，选了会有不明显后果（删数据、断开、要重启、影响别的设备）才加一句说明。按钮为什么不能点、出错原因和怎么办、不可撤销的后果必须写。英文按英文产品习惯写，不逐字对译；产品名写作 Codex、Claude Code、Pi、DSH、OpenCode。
- 验收里换外观一律用 `window.__litchLook`。
- 移动端的界面预览：`apps/mobile` 里 `npm run preview`，在浏览器里用正式页面对着模拟核心，场景在 `src/preview/scenes.web.ts`。预览专用的代码只写成 `*.web.*`（替身放 `src/preview/`），`npm run preview:check` 守着它不进手机的包。
- 加功能或改了用户看得到的行为，在同一个提交里改产品手册 `skills/litch-manual/`。

## 测试

- 测试不继承个人模型凭据，用回环上的假模型；开发和自检不连自己真实的入口，用 `scripts/` 下的夹具。
- 一律用隔离的 `HOME`、`CODEX_HOME` 等配置目录，不碰真实的 `~/.codex`、`~/.claude`；测试和验收绝不在本机真实环境装或升级 harness。
- 真实 Claude Code 测试要用 `CHA_CLAUDE_CLI` 指一份隔离的官方 CLI。
- 流水线分两档：门禁 `ci.yml` 只放快且拦“一上来就撞上”的冒烟，墙钟控制在 20 分钟内；其余新检查默认进全量 `full.yml`（发版前手动触发）。

```sh
npm ci && npm ci --prefix packages/claude   # 其余引擎包同样各装一次
npm run build
npm run check:fix && npm run typecheck && npm test
npm run client:setup && npm run client:typecheck && npm run client:test
```

客户端的各项验收命令见 `package.json` 的 `client:check:*`，各脚本开头写着用法。

## 更多约定

- 包内约定：`packages/claude/src/AGENTS.md`、`packages/claude/test/AGENTS.md`、`scripts/AGENTS.md`。
- 面向用户的说明：`README.md`（首页，只讲是什么和怎么跑）、`ADAPTER.md`（适配器的安装、配置与排障，保持简短）、`CONTRIBUTING.md`（发版）。
