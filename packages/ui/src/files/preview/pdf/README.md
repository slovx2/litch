# PDF 只读预览

`renderers/pdf.tsx` 由现有 glob 分派按需加载。输入只有 `files.preview` 已取到的字节，远程设备与本地设备使用同一接口；本模块不改协议或手机，不直接读取路径。依赖 `pdfjs-dist 6.4.299`（Apache-2.0），库和 Worker 不进入首屏入口。

## 资源与安全

- PDF 每份独占 module Worker；仅从构建内启动，不使用 fake-worker。文件限制 20 MiB / 200 页；本地再次校验实际解码字节数，页元数据只解析尺寸，不预画全部页面。
- `assets.ts` 用 `BinaryDataFactory` 按 kind + 文件名白名单加载构建内 JS 数据模块，CMap、标准字体、OpenJPEG/JBIG2 WASM 随应用打包，`useWorkerFetch:false`。文档不能指定库资源地址。未捆绑 QCMS、quickjs、PDF scripting manager、完整 viewer。
- 主文档 meta 禁止连接、JS eval 和 WASM 编译。正式 `app://` 的全部响应另外附带 `connect-src 'none'; script-src 'self'; worker-src 'self'`，避免只有 meta 时 Worker 没受约束。`pdf-worker-<hash>.js` 使用独立响应策略：`default-src 'none'; connect-src 'none'; script-src 'wasm-unsafe-eval'; worker-src 'none'`，仅它可以编译 WASM，fetch/WebSocket 和远程/本地 import 都被浏览器拒绝。WASM 字节来自固定模块白名单。不开 annotation layer、表单、附件、XFA、外链或自动动作。
- 200 页的尺寸轻量占位；仅可见页及前后各一页挂载 Canvas/TextLayer。当前挂载页面累计最多 1600 万画布像素、单页 400 万；设备 DPR 最多 2，放大后可降低光栅分辨率。单张 PDF 内图像最多 800 万像素（超限由 PDF.js 省略），每页文字最多 10,000 项 / 100,000 字符，超限保留画布并提示无法选择文字。
- 文档初始化和单页处理分别设 20 秒超时，终止整份文档 Worker；主线程绘图不能宣称有硬 CPU 超时。解析压缩对象的工作内存由 PDF.js 管理，字节和像素预算不等价于浏览器进程总内存硬限额。
- 取消、切换、刷新、关闭：取消页渲染与文字流、清零画布、清页缓存，等待 PDF.js destroy 完成再终止 Worker，最多等 500ms 后强停。`dom.ts` 经公开 `ownerDocument` 参数记录字体和滤镜 DOM，无销毁回执时仍可清掉这份文档的资源；不删除其他应用字体。文字层共享测量缓存由库的 cleanup 清理。
- 本地资源字节由构建器嵌入惰性模块，动态模块本身可由浏览器缓存复用；它们不是用户 PDF 内容。用户字节/页内容不落盘。

PDF.js 在 `useWorkerFetch:false` 下关闭 QCMS 的同步 Worker fetch 路线，特殊 ICC/CMYK 使用库的默认颜色处理，不承诺专业印前色彩保真。字体未嵌入时可有替代字形。密码文件不收集密码，只显示占位。

## 许可证与验收

`apps/desktop/scripts/licenses.mjs` 将包根 LICENSE 以及 cmaps、standard_fonts、wasm 里实际分发资源的 LICENSE 原样合并进分发许可文本（不带 QCMS 两份许可）；`THIRD_PARTY_NOTICES.md` 记载来源。可选的 Node canvas 依赖仅在锁文件中固定，不进入浏览器代码或桌面渲染包。

`node scripts/check-file-preview-pdf.mjs` 使用隔离 headless Chrome、生产 CSP 和正式文件面板。自建 PDF 夹具位于 `scripts/pdf-fixtures.mjs`：中文/英文、旋转、扫描图、JPEG2000、200/201 页、密码/损坏/字节和页面超限、恶意 JavaScript/URI、文字预算。检查文字选择、可见页、像素、字体和 Worker 释放、刷新及超时，输出六套外观截图与 JSON。CSP 探针显式关闭 CDP 的 eval 豁免，并检查 violation 事件，不用 DevTools 放宽后的执行结果作为安全证据。

`packages/ui/test/pdf-policy.test.mjs` 守尺寸与虚拟页/像素预算；UI/core 类型与现有预览脚本仍须通过。实机 Windows 尚未验收，浏览器 headless 不能代替所有 Electron 平台的字体和 GPU 行为。

`node scripts/check-file-preview-pdf-electron.mjs` 使用真实、始终隐藏的 Electron 和正式 `serveUiResource`。无 API 覆盖的 Worker 探针记录原生 fetch/WebSocket/import 的 CSP violation，并验证本地 JPEG2000；还检查 Markdown、Mermaid、高亮 Worker、PNG/SVG、模拟 Computer Use 预览。无系统输入，不开调试监听端口；系统只读窗口/焦点守卫发现可见或激活立即停止整树。

`node scripts/check-file-preview-pdf.mjs --dev` 验证 Vite 预览仍可运行。开发主文档只为 HMR 额外允许 React refresh 内联前言和当前 Vite 本机 HTTP/WS 地址；PDF Worker 开发时直送同版本的本地单文件库，独立响应 CSP 与正式完全一致。检查还断言正式构建的 meta 不含开发例外。开发放开项不作为安全边界；安全结论以正式构建及 app:// 验收为准。
