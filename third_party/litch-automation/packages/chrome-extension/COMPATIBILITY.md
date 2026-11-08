# M3-C 抽取与互斥验收

基线为重新导出的 `f39ec336` 源码，以同一 esbuild 0.28.2 从源码重建；没有复用旧 dist。候选版本为 0.34.1。2026-11-06，macOS arm64、Node 24.21.0、Chrome for Testing 151.0.7922.34。只操作隔离 HOME/profile/NativeMessagingHosts；未读写日用 Chrome 登记。

## 交付文件

| 文件 | 逐字节比较 | 字节数（基线→候选） | 候选 SHA-256 |
|---|---|---:|---|
| background.js | 改变 | 53924 → 61472 | `8d279f366b30a76440ee6a7d7338348124599bc9d84c15998dd7b6bf282f64b7` |
| icon-128.png | 一致 | 6274 → 6274 | `1ac54912b1cdfafde967ca901a9ee559cabf5e382bd6365d95cc0ea6d9cbf1e9` |
| icon-16.png | 一致 | 570 → 570 | `84abd7e6b32cc50719b09b5bcb698bc85af73a21bb37d78cefa9c7acc29f4718` |
| icon-32.png | 一致 | 1426 → 1426 | `511a9eeb4acd6869abac53ed0a867d8b5f8c6015762f2f01fdc51fcb14ea4e66` |
| icon-48.png | 一致 | 2394 → 2394 | `f4797a903bfb0b0dfbfef9119b09876282c93976557d29f338b5aa197b4bd80f` |
| identity.json | 一致 | 61 → 61 | `4ce06298c7b2cf8ad61ee5e9dc4a6a5def4dae167eff909938d2958e8cd2f3da` |
| manifest.json | 一致 | 1148 → 1148 | `6892be0241aa571d358e2ea59a3115da05070c02b8db173662f4fc229671827e` |

`background.js` 基线 SHA-256：`5ab64a49724572bdfb3904cb0467fd4cf26329a420b804d6c825c4b5d8e1a78e`。

唯一改变的交付文件是 background.js。变更来源逐项为：

- 代码路径转入能力包，esbuild 的来源注释和模块排列随之改变；无操作语义变化。
- 模块级自动启动改为库的 create/start/stop，apps 入口显式启动；Litch 仍在 worker 启动时连接。补齐停止时监听器、定时器、在途请求和原生 port 清理，避免嵌入宿主停用后仍执行。
- host/允许 ID/协议范围/展示/存储前缀/光标源码改为可信配置；Litch 传入原值。内容脚本和 pointer renderer 由纯 DOM 库组成，world 名和样式语义保留。
- preflight 拒绝已有调试器，postflight 只验证目标仍存在并附着。旧版 Chrome 可允许不同扩展同时 attach，这里不能靠布尔 attached 做原子锁。
- list/new 增加真实 targetId 元数据，已有 claim.args 承载它；Go 转发前持系统文件锁，冲突返回 busy。扩展在 attach 前复核目标未变。这是明确的安全行为变化，保护使用同一锁目录的新组件。

manifest、权限、最低 Chrome 版本、公钥、开发 ID `fakgembkgnmeknpaegnneneockbjhaai`、商店 ID `ddnllmibgnhhiiaaidfamlknbnfjpnpo`、host `ai.litch.chrome`、协议范围 1–1 均保持；四个图标和 identity.json 没有差异。未增加 wire 消息类型或操作类型，模型工具 schema 也未改变。

**background.js 的实际内容改变，发布商店实例需要提高版本并重新送审。** 本线没有上传/送审/发布；本比对只证明 f39ec336 源码与候选，不代表已重新核对商店签名包。

## 实测

- check、client:typecheck、两个新包构建均通过。
- wire、bridge、扩展、安装/站点/分组及 SDK 端口：30/30 通过，0 跳过。
- Go chromebridge：8/8 通过，0 跳过，包含跨进程排他、崩溃释放、旧 metadata 路径和帧转发。
- client:build 后，headless 普通场景 28/28 通过；第二身份使用自己的 ID/host/token/安装根和独立最小 Go host，Litch 登记字节不变。
- 低负载窗口（启动时 1 分钟负载 25.28）执行 5 轮双扩展同时 claim：0 轮双方成功，5 轮均有明确 native host claim lock 的 busy 拒绝；每轮核对两个扩展看到同一实际 CDP targetId。测试不重放输入、不增大原有安全超时。
- 锁获取加释放 1000 次：p50 19.916µs，p95 64.875µs，p99 246.75µs，最大 722.25µs。包含 JSON 解析、打开文件、内核锁与释放；不代表整个 Chrome claim 或文件系统冷启动耗时。没有新增 IPC 往返，新增系统调用不等于零成本。
- 两个 npm tarball 在仓外安装并导入成功；无 Electron，无仓库源路径补漏，无 import 自动连接/登记。版本与包间投影同源。

早期仅用 getTargets 的诊断曾报告 5 轮中 4 轮双成功，首次单轮的两扩展目标 ID 前后均一致。早期多轮复用 URL/探针变量，4/5 只保留为历史诊断，不当作最终精确概率；最终夹具改为每轮唯一 URL、独立会话、等待文档完成，且直接核对目标和原生 busy。高负载（1 分钟负载一度 594）期间另有 pointer/30 秒桥超时，已保留失败日志，未靠调阈值或重试输入掩盖。

## 边界与待验

【事实】两个扩展观测同一页面得到同一 targetId；目标 ID 不属于某个扩展的 storage instanceId。Chromium 的页面 agent host 取浏览器生成的 devtools_frame_token，类型为随机 UnguessableToken。[构造源码](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/content/browser/devtools/render_frame_devtools_agent_host.cc#354)，[token 生命周期说明](https://chromium.googlesource.com/chromium/src/+/23a579b9e602df1ec3c45aff1015066419691971/content/browser/renderer_host/render_frame_host_impl.h)。

【推断】基于随机 128 位标识，不同 Chrome 实例/profile 不需再加扩展/产品前缀。极端目标碰撞只会误拒绝，不会授予别的页面权限。尚未独立跑多个 Chrome profile 的目标唯一性验收；目标激活切换时应依赖 attach 前身份复核，不能把 targetId 当永久标签编号。

互斥仅覆盖双方都使用新 Node/扩展/Go 组件并显式传同一共享锁目录。旧扩展无 targetId metadata 时维持原有 wire 1 行为；其他调试器不遵守锁约定时只受 Chrome 与前置占用检查保护。没有竞争者时，单个 Litch 正常认领、来源授权、登录冻结与租约语义保持。

没验：Windows 真实 LockFileEx/注册表和 Linux 实机；本轮系统锁运行证据来自 macOS。
没验：正式商店签名安装与商店发布包本身、真实用户 profile。
没验：WakeQora 实际产品打包/签名/联调，以及两版本 Electron 的 M4 集成夹具。
没验：独立多 Chrome profile、prerender 激活边界的专项验证；完整引擎 test:compat 和手机不在本线范围。
