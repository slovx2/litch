# PDF 只读预览

`renderers/pdf.tsx` 由现有 glob 分派按需加载。输入只有 `files.preview` 已取到的字节，远程设备与本地设备使用同一接口；本模块不改协议或手机，不直接读取路径。依赖 `pdfjs-dist 6.4.299`（Apache-2.0），库和 Worker 不进入首屏入口。

## 资源与安全

- PDF 每份独占 module Worker；仅从构建内启动，不使用 fake-worker。文件限制 20 MiB / 200 页；本地再次校验实际解码字节数，页元数据只解析尺寸，不预画全部页面。
- `assets.ts` 用 `BinaryDataFactory` 按 kind + 文件名白名单加载构建内 JS 数据模块，CMap、标准字体、OpenJPEG/JBIG2/QCMS WASM 随应用打包，`useWorkerFetch:false`。文档不能指定库资源地址，Worker 的 fetch/XHR 也直接拒绝。未捆绑 quickjs、PDF scripting manager、完整 viewer。
- 生产 CSP 保持 `connect-src 'none'`，显式 `worker-src 'self'`；`script-src` 只增加 `'wasm-unsafe-eval'`，未允许 JS eval。WASM 字节来自固定模块白名单。不开 annotation layer、表单、附件、XFA、外链或自动动作。
- 200 页的尺寸轻量占位；仅可见页及前后各一页挂载 Canvas/TextLayer。当前挂载页面累计最多 1600 万画布像素、单页 400 万；设备 DPR 最多 2，放大后可降低光栅分辨率。单张 PDF 内图像最多 800 万像素（超限由 PDF.js 省略），每页文字最多 10,000 项 / 100,000 字符，超限保留画布并提示无法选择文字。
- 文档初始化和单页处理分别设 20 秒超时，终止整份文档 Worker；主线程绘图不能宣称有硬 CPU 超时。解析压缩对象的工作内存由 PDF.js 管理，字节和像素预算不等价于浏览器进程总内存硬限额。
- 取消、切换、刷新、关闭：取消页渲染与文字流、清零画布、清页缓存，终止 Worker。`dom.ts` 经公开 `ownerDocument` 参数记录字体和滤镜 DOM，强制终止导致 PDF.js 无销毁回执时仍可清掉这份文档的资源；不删除其他应用字体。文字层共享测量缓存由库的 cleanup 清理。
- 本地资源字节由构建器嵌入惰性模块，动态模块本身可由浏览器缓存复用；它们不是用户 PDF 内容。用户字节/页内容不落盘。

PDF.js 在 `useWorkerFetch:false` 下关闭 QCMS 的同步 Worker fetch 路线，特殊 ICC/CMYK 使用库的默认颜色处理，不承诺专业印前色彩保真。字体未嵌入时可有替代字形。密码文件不收集密码，只显示占位。

## 许可证与验收

`apps/desktop/scripts/licenses.mjs` 将包根 LICENSE 以及 cmaps、standard_fonts、wasm 里的资源 LICENSE 原样合并进分发许可文本；`THIRD_PARTY_NOTICES.md` 记载来源。可选的 Node canvas 依赖仅在锁文件中固定，不进入浏览器代码或桌面渲染包。

`node scripts/check-file-preview-pdf.mjs` 使用隔离 headless Chrome、生产 CSP 和正式文件面板。自建 PDF 夹具位于 `scripts/pdf-fixtures.mjs`：中文/英文、旋转、扫描图、JPEG2000、200/201 页、密码/损坏/字节和页面超限、恶意 JavaScript/URI、文字预算。检查文字选择、可见页、像素、字体和 Worker 释放、刷新及超时，输出六套外观截图与 JSON。CSP 探针显式关闭 CDP 的 eval 豁免，并检查 violation 事件，不用 DevTools 放宽后的执行结果作为安全证据。

`packages/ui/test/pdf-policy.test.mjs` 守尺寸与虚拟页/像素预算；UI/core 类型与现有预览脚本仍须通过。实机 Windows 尚未验收，浏览器 headless 不能代替所有 Electron 平台的字体和 GPU 行为。
