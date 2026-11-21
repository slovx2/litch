# 可嵌入 Chrome 扩展

这是 MV3 service worker、标签租约、受限 CDP 执行器和 isolated-world 光标的库。它不交付商店扩展，不注册 native host，也不在 import 时启动。Litch 的实例位于 `apps/chrome-extension`。

包名为 `@litch/chrome-extension`，首版使用独立的 `0.x` semver，不再跟随 Litch。构建入口依赖精确的 esbuild 0.28.2；运行入口不加载 Node/Electron。扩展 key、ID、manifest、图标、商店上传和签名由使用方负责；独立仓只发布源码和 npm 包。

```ts
import { createExtensionRuntime } from '@litch/chrome-extension'

const runtime = createExtensionRuntime({
  chrome,
  identity: {
    hostName: 'example.automation',
    extensionIds: [EXTENSION_ID], // 构建时固定的允许列表
    productName: 'Example',
  },
  protocol: { min: 1, max: 1 },
  storagePrefix: 'exampleAutomation',
  pointerSource: POINTER_IIFE, // 构建时嵌入 isolated-world 入口的 IIFE 文本
})
await runtime.start()
// 应用卸载自动化能力时：
await runtime.stop()
```

自己的 pointer 入口调用 `import { installPointerWorld } from '@litch/chrome-extension/pointer-world'; installPointerWorld()`。它只在独立 world 内安装接口，不派发网页输入。不要从默认 browser index 引入 DOM renderer，因为该入口还包含 Node 工具。

`@litch/chrome-extension/build` 的 `assembleExtension` 接收 output、background、pointer、pointerDefine、identity（key/id）、manifest、icons（绝对文件路径数组）。它构建两个入口，核对公钥与扩展 ID，输出平铺文件。manifest、权限、图标、名字由使用方拥有；不得复用 Litch 的 key/ID。现有能力需要 debugger/nativeMessaging/tabs/tabGroups/storage/webNavigation，最低 Chrome 125；不需要 host_permissions。合并业务扩展时应只注册一套控制同一标签的 debugger 处理器。

配置必须来自可信组装入口；模型、网页不允许选择 host 名、协议或批准身份。v1 运行时只实现协议 1，传入其他范围会失败。`stop` 撤本实例监听器、定时器和租约；不删除其他模块的监听器。原生断线、用户停止、租约过期、文档变化、登录冻结继续在每步执行前后核对。储存键由 storagePrefix 隔离，Chrome 另按扩展 ID 隔离 storage。

AI 工具定义与宿主侧执行器在 `@litch/chrome-bridge`，不是通过网页消息调用本库。wire 类型来自 automation-contracts 唯一源；v1 中 `litchVersion`/`litchOutdated` 字段名是既有线上协议，不代表默认信任 Litch 身份。光标的 isolated-world 私有符号也保留原名以保持页面观察语义，不作为跨扩展信任凭证。

橙色组和逐标签 `AI` 徽标表示有效租约。续租、短暂空闲和连续工具调用不重涂；交还、停止、断线或租约到期立即恢复。主文档导航后仅在 Chrome 清除了逐标签徽标时补画。

测试：`npm run test --prefix packages/chrome-extension`；完整隔离 Chrome 链路见 `scripts/chrome-e2e/README.md`。正式 Chrome 商店签名安装、其他宿主产品打包和真实用户 profile 不在这些测试内。Chrome 实际允许多个扩展 attach 同一标签；库先用 getTargets 拒绝已附着的目标，attach 后验证目标仍存在并附着。没有其他调试器时，单个 Litch 的正常认领不受影响。

标签列表保留 Chrome 内部页、扩展页面、Chrome 网上应用店和错误页，并用 `unavailableReason` 说明无法认领的原因；URL 已知受限时，在读取框架和 attach 前拒绝。提示按 Chrome 界面语言提供中文或英文，建议新开普通 HTTP(S) 标签。attach 的其他失败保留 Chrome 原始错误及异常 cause，分别说明策略限制、调试器占用、目标消失与未知错误。扩展 service worker 日志和工具提示中的 URL、认证头及显式秘密先脱敏，并限制诊断长度；原始 cause 只在内存中保留，不记录原异常对象。不会把未知错误推断成 DevTools 占用。

Litch 设备路由签发的 `chrome:litch-…` 句柄属于产生它的回合。回合结束、中断或重启后须重新调用 `targets`；迟到结果仍属于旧回合。普通网页导航改变文档 refs，不改变 Chrome 实例的 targetId；桥重连会撤租约，同回合可用 `ensure_claimed(tabId)` 重新验证原标签。

按随包 LICENSE 的 MIT 条款分发。未包含他人产品素材或私钥；宿主自己发布和审核其扩展实例。

**互斥前提：两个宿主都使用新组件，且显式配置同一共享文件锁目录。** `list/new` 的真实 targetId 元数据在已有 claim.args 中传给 Go，原生 host 先持有系统锁才转发 claim；失败返回 busy。attach 前仍核对目标没有变化及没有已有调试器。只用 getTargets 的旧方案已复现 5 轮中 4 轮双方成功；后置 attached 布尔值无法辨识连接者，不能代替系统锁。旧扩展没有 metadata 时保留原协议行为，未加入锁约定的扩展/DevTools 不受文件锁仲裁。路径、生命周期和其他宿主 接线见 chrome-bridge 包 README，最终测试与哈希见 [COMPATIBILITY.md](./COMPATIBILITY.md)。[Chrome API](https://developer.chrome.com/docs/extensions/reference/api/debugger#type-TargetInfo)
