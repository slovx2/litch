# Antigravity 引擎

`agy` 是统一入口，默认订阅模式。API key 模式使用 TypeScript 直连固定 SDK localharness，订阅模式加载
相邻 `packages/acp/dist/acp/src/server.mjs` 的 AcpServer，使用官方 `agy acp`。

- `CHA_ANTIGRAVITY_HOME`：外壳状态目录；内部 `sdk/`、`acp/` 独立。
- `GEMINI_API_KEY`：SDK 模型凭据，不传到 ACP 后端。密钥由设备设置保存，不写会话索引。
- `CHA_ANTIGRAVITY_CLI`：可选 SDK runtime 路径，仍须通过固定摘要验证。
- `CHA_AGY_CLI`、`CHA_AGY_ARGS`：官方订阅 CLI 路径和参数，由 ACP 引擎解释。
- 详情设置的 `authenticationMode` 只选新建后端。外部会话号 `agy:sdk:<id>`、`agy:acp:<id>`
  固定来源，列表汇总，不转换历史。声明了 `threadCapabilities` 的连接取得会话实际能力。

SDK 首次建会话时按需获取官方 PyPI wheel，不安装 Python。`src/artifacts.json` 同时锁定发行版本、
来源提交、六个平台 wheel、可执行文件和生成 schema 的摘要。只解出固定成员；不携带第三方程序，
不接受未知版本。升级前须重算锁文件、核对 schema、复验真实 runtime 和同版本恢复。

SDK 第一阶段支持文字流式、内置文件和同步命令工具、每次工具审批、中断、自建列表和恢复。
没有 OS 沙箱；拒绝只读／workspace 档。工具拒绝属于步骤失败，根 trajectory 结束才收尾回合。
子代理、提问、计划、MCP、自定义客户端工具、分叉、异步命令均未启用，runtime/info 如实声明。
SDK 不支持消费订阅 OAuth；订阅只交给官方 ACP。没有凭据自动提取或私有云端协议。

```sh
npm ci --prefix packages/antigravity
npm run test:antigravity  # 默认仅路由和打包加载
# SDK 测试只手动触发，默认 npm test / CI / full 不执行
npm run test:antigravity-sdk
# 显式提供隔离安装的固定版本程序；缺少时失败，不跳过。
TEST_ANTIGRAVITY_BINARY=/absolute/path/localharness npm run test:runtime --prefix packages/antigravity
```

手动 SDK 测试使用假 localharness；`test:runtime` 使用真实 localharness + 回环假 Gemini、假 key 和独立 HOME，
覆盖流式、审批允许／拒绝／取消、文件写入、中断、过期凭据与恢复。不得用真实账号运行测试。
协议依据 Google LLC 的 Apache-2.0 SDK 0.1.23；来源和许可见仓库 `THIRD_PARTY_NOTICES.md`。
