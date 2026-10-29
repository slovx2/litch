# 公共光标接入

`pointer-renderer.ts` 不依赖 React/Electron；浏览器适配器可以把它 bundle 到自己的 isolated world。
协议形状只有一份：`packages/protocol/src/automation-surface.mts`。
导出接口为 `AutomationPointerRenderer`、`PointerRendererOptions`、`PointerArrival`；
宿主只传可信主题颜色和几何、动作样本，不需要 CU 助手、React 或桌面 IPC。

```ts
const renderer = createAutomationPointer(document.documentElement, {
  surface, frame, fixed: true, color: trustedThemeColor, outlineColor: trustedOutlineColor,
  reducedMotion: () => matchMedia('(prefers-reduced-motion: reduce)').matches,
})
const receipt = await renderer.update(plannedSample)
// 适配器在这里重新核对 tab/target/lease/turn、generation、revision、actionId、seq。
// arrived 是已走过绘制帧；timedOut/hidden 不声称动画完成，也不授予动作权限。
// 只有适配器自己的授权和取消检查允许，才派发真正 CDP 动作。
await renderer.withoutPointer(() => captureScreenshot())
renderer.geometry(newSurface, newFrame)
renderer.dispose()
```

- 浏览器位置必须是顶层 viewport CSS px。frame 的 contentRect 对应同一 surface；iframe/OOPIF、
  scroll、zoom、visualViewport 的换算由浏览器适配器负责，变化时递增 geometryRevision。
- 每个 update 的回执带完整 sample 身份；新动作、换几何、销毁会结束旧等待，旧回执不能放行新动作。
  可见时动画预算 120ms、等待计时器预算 160ms；隐藏标签立即回 hidden，不激活标签。
  页面事件循环被挂起时计时器也可能延后，宿主应有独立的动作截止时间，不依赖网页计时器作硬超时。
  arrived 表示已走过浏览器绘制机会，不证明用户实际看见；尺寸/帧裁剪变化时回 superseded，
  回执前页面隐藏或宿主节点被移除时回 hidden。宿主宽高改变会重算坐标，不沿用旧动画目标。
- phase planned/dispatched/completed/failed/cancelled 原样传入。只有实际派发后发 dispatched，
  失败或取消清除 pressed。path 有真实采样点时沿点插值，否则只作前后位置之间的短插值。
- 截图必须 await withoutPointer；嵌套隐藏会计数，恢复不会让已销毁的光标复活。
  AX/ref 枚举排除 `[data-litch-automation-pointer]` 宿主及其后代。
- 叠加层 mouse 穿透、AX 隐藏、closed ShadowRoot；不监听网页消息、不暴露宿主 API。
  isolated world 隔离的是脚本状态，不隔离共享 DOM：恶意页面仍可能删除/遮挡宿主，
  所以光标存在或 arrival 绝不是安全凭证。浏览器线负责在导航、登录交接、detach、接管、
  回合结束、断线时销毁，并在新文档重建实例。
- 浏览器使用 `fixed:true`，坐标以顶层 viewport 为准；普通预览容器用默认的绝对定位，
  容器须建立定位上下文。父容器应覆盖对应图像显示区域，frame 描述图像本身，
  renderer 根据容器尺寸作 contain 映射。该模块不反向派发点击或改变系统鼠标。

验证命令（Node 24，仓库根目录）：

```sh
node --test packages/ui/test/pointer-renderer.test.mjs packages/protocol/test/automation-surface.test.mts
```

renderer 测试使用可控绘制时钟与最小 DOM，覆盖顺序、回执、取消、几何、轨迹和截图隐藏；
不替代浏览器线的真实 Chrome 挂载、截图排除与视觉验收。
