# 可嵌入浏览器

M3-B 进行中。当前稳定接口包括语义 `BrowserDriver`、`CdpHost/CdpPage`、注入式站点存储、`CdpDriverOptions` 和 Electron/导航端口；真实驱动、登录与导入迁移随后接入。包目前 private，内部构建名不表示 npm 发布名。

Chrome 线可依赖：

- `src/browser/model.mts`：CDP 页面/标签宿主。ChromePage 可以实现它，不引用 Electron；低层 CDP 不进入模型参数。
- `src/browser/sites.mts`：`createSiteBook(file | SitePersistence | null)`，独立 browser/Chrome 授权实例；文件路径由宿主传入，不改变 once/session/always 和拒绝规则。
- `src/ports.mts`：`CdpDriverFactory` 返回 `BrowserDriverRuntime`，输入 `hostId/host/sites` 及可选的可信冻结、变更、存储落盘钩子；语义接口沿公共合同，CDP 仅为实现。
- `src/tool-port.mts`：当前工具适配器的调用/答复/审批端口，结构保持 Litch 接线，包不依赖 Litch core/protocol。第三方可以使用语义 driver，不需要使用 Litch 工具传输形状。
- `src/browser/cdp-allow.mts`、`ax.mts`、`args.mts`、`keys.mts`：现有白名单与页面工具基础，归本包维护，不在扩展线复制。

`apps/desktop/src/browser` 的同名入口是 Litch 接线外观；主进程/UI/Chrome 的 imports 由集成线统一更新。在此期间所有实现只有本包一份，没有旧数据回退或双实现。

运行：`npm run build --prefix packages/browser`、`npm run test --prefix packages/browser`。测试使用虚拟站点存储，不连接真实浏览器。按根 LICENSE 的 MIT 条款分发。
