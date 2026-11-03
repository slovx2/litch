# 手机文件预览

`FileView` 接收 `content`、`line?`、`deviceId`、`root`、`fragment?`。`root` 必须是文件
解析成功后的文件树根；请求路径取 `content.path`。`fragment` 暂不定位标题。路由和候选
解析属于 `FilesScreen`，预览不再从路由重新猜设备或根。

- 图片/PDF 使用 `files.preview`，核心负责 `filePreview` 能力与字节预算。预览内容只存在
  页面内存里，不写手机文件、不加入副本。失焦卸载 WebView、清空内容并取消未完成的命令。
- PNG、JPEG、静态 GIF/WebP 复用桌面的 `imageInfo`，解码前核对结构和像素预算。
  SVG 沿用源码视图，不进入 WebView。其他二进制格式提供说明和复制路径。
- PDF.js 和它的 worker、CMap、标准字体、OpenJPEG/JBIG2 从桌面包的精确版本依赖构建。
  没有新增移动端/原生依赖。不引入 viewer、脚本/动作/注释层；每次只有一页画布，
  翻页释放上一页，缩放只改变变换，不分配更大的画布。预算复用桌面的 `pdf/policy.ts`。
- 构建脚本是 `apps/mobile/scripts/build-webview-file-preview.mjs`，包含在 `web:build`。
  内联资源先 gzip 再 base64，生成文件不提交；运行时不从网络加载资源。
- WebView 的 CSP 禁止网络、嵌套页面、表单；原生回调拦截外部导航，禁用文件访问。
  `https://file-preview.litch.invalid/` 只作为内联 HTML 的来源，**不是请求地址**。
  Android WebView 拒绝 `about:blank` 下的 `blob:null` worker，不能删去 `baseUrl`。
- 模块 worker 的 blob URL 必须等握手成功或销毁后再撤销。WebView 124 上在 `new Worker`
  后立即撤销，会收到没有 message 的 error 事件；桌面新 Chromium 不一定复现。
- WebView 124 缺少现代 PDF.js 使用的 `Promise.try`、`Map.getOrInsertComputed`。
  因此使用同版本官方 `legacy/build` 主模块与 worker；应用不维护自有 polyfill。

## 局部验收

```sh
npm run typecheck --prefix apps/mobile
node --experimental-transform-types --disable-warning=ExperimentalWarning \
  --import ./apps/mobile/test/register.mjs --test apps/mobile/test/file-preview.test.mjs
```

`apps/mobile/test/file-preview-fixtures.mjs` 的 `writePreviewFixtures(root)` 在隔离 SSH
夹具的 `work` 下生成 `preview/`：PNG、双页 PDF、9 MiB 图片、21 MiB PDF、损坏文件、
超像素图、201 页 PDF、超尺寸 PDF、Office 和 SVG。不要传用户的工作目录。

用正式 release APK 连接 `apps/mobile/scripts/fixture.mjs`，在会话菜单打开文件，再进入
`preview/`。`files:preview-ready` 只在实际解码/画布渲染完成后出现；PDF 翻页测试需同时
检查 `files:page`。图片需要在 Android 输入层实际执行双指缩放、单指拖动和双击复原。
损坏和超限文件应显示对应原因，且能复制路径；SVG 应显示源码。结束后关闭自己启动的
无窗口模拟器、夹具和构建进程，不保留截图。
