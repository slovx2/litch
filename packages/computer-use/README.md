# Computer Use 嵌入库

`computer-use-internal` 是暂定的内部构建名，版本跟随 Litch；先交 tarball，不代表已公开发布 npm。Node 24+，无 Electron 运行时依赖。原生助手由使用方构建、签名和嵌入自己的应用。

- 默认入口：`createComputerUse` / `createComputerExecutor`，使用 M2 的 `ToolInvocation`、`InvocationContext`、`ToolResult`。宿主提供 `HelperAccess` 与 `disposeHelper`，不会自动查找任何产品路径。
- `/tools`：`computerTools`，来自 automation-contracts 唯一源，支持 macOS、Windows、portable 与批量能力开关；产品名、助手名和命名空间显式提供。
- `/node`：帧连接、Mac/Windows 启动器、看护者、`createNodeComputerUse`。Mac 身份、环境键、运行目录和路径由宿主给定；Windows 指定助手路径和产品名。
- `/wire`：原生帧及平台结果类型。

`hostId` 固定在 runtime 上，调用来源只能由可信宿主填写；来自其他 host 的调用被拒绝。自身访问先由助手检查真实进程，再由宿主审批，答复会校验请求号、随机数和完整 scope。缺失/取消/过期/错绑定的答复不会授权。24 小时授权的存储是可选注入项；不给存储时仅留在该 runtime 内存中。

每回合结束调用 `executor.endTurn(scope)`；会话销毁调用 `endSession`；应用退出先 `dispose()`，等待完成后再终止宿主。调用中止使用 AbortSignal。预览通知只走本机 `onAutomation`，不要写进聊天历史。

构建：在仓库安装精确锁定的依赖后，`npm run build --prefix packages/computer-use`。当前独立编译把实际引用的 contracts 唯一源一并投影到 `dist/automation-contracts`；发布白名单只带 `dist`，不需要仓库源码或路径别名，也不手工维护第二份合同。

Litch 的入口在 `apps/desktop/src/computer-use`：路径定位、手机验签、审批文件和设置 UI 留在宿主；实际执行器、批量、帧、启动器与看护来自本包。公共构建/版本/打包/CI 接线由集成线维护。
