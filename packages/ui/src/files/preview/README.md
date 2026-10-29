# 文件预览渲染器

共用代码负责读取、预算、来源、模式、错误、刷新和取消；一个格式一个 `renderers/<format>.tsx`，默认导出接收 `PreviewRendererProps` 的 React 组件。`registry.ts` 在构建时发现这些文件、运行时懒加载；不要从中心分派文件直接 import 重库。

## 接口

- `scope`：`deviceId/root/path`，都是文件所属设备的路径。不得用客户端 fs、file URL 或 shell 读文件。
- `data`：已受设备限额约束的 `dataBase64/bytes/format/path`。文本自行严格 UTF-8 解码；文档库使用 bytes 输入，不准自行 fetch 路径或 URL。
- `resources`：当前文件这一代的资源生命周期；`load(scope, format, true)` 读取附图（2 并发、16 张、16 MiB 累计），`claimPixels(key, count)` 约束累计解码像素。组件创建的 Blob URL/Worker/文档实例须在 effect cleanup 中释放。
- `open(path,line?,fragment?)`：仅用于用户点击，先由 `documentTarget` 验根。外链用 `ExternalLink`，不得直接修改 location/open/window。
- `fragment`：文件内标题，不是脚本/URL。

数据不进入会话订阅副本，也不落盘。切文件、关闭预览、刷新会释放资源；不依赖“组件隐藏后迟早 GC”。`FileContent` 与手机的文件查看不受新二进制结果影响。

## 第二期文件归属

| 线 | 独占文件 |
|---|---|
| PDF | `renderers/pdf.tsx`、`pdf/`、自己的测试与 `pdf.css` |
| DOCX + XLSX | `renderers/docx.tsx`、`renderers/xlsx.tsx`、`office/`、自己的测试与 `office.css` |
| CSV + HTML + 媒体 | `renderers/csv.tsx`、`renderers/html.tsx`、`renderers/media.tsx`、`web/`、自己的测试与 `web.css` |
| 主线维护 | contract/registry/resources/paths、PreviewPanel、FileViewer、协议/核心、共享翻译入口、依赖清单和锁文件、全局 CSP |

三条线各自新增 `i18n/zh-CN-preview-<格式>.ts` 和 `i18n/en-preview-<格式>.ts`，沿用全局 `useT()` 与 `t('键',参数)`，以中文目录决定 MessageKey，英文必须齐全。主线合并时在两个总目录补充对应导入和展开，不增加独立翻译接口。依赖精确版本需求交主线统一写 package.json/lock，避免互相覆盖。CSS 从自己的 renderer import，使用皮肤变量。PDF Worker/CMap/字体、Office 沙箱及 HTML frame 所需 CSP 由主线审阅后统一加入，不能放宽全局网络或脚本策略。

核心 `PreviewKind` 与预算已经预留 pdf/docx/xlsx/csv/html/media。未提供模块的格式照旧看源码或类型占位；增加模块即启用，没有第二份扩展名表要修改。仅 `.md/.markdown`、PNG/JPEG/静态 GIF/WebP、静态 SVG 在第一期启用；不支持的图片不交给任意解码器尝试。

PDF 已接入：实现、安全预算、许可证和无前台验收入口见 [pdf/README.md](pdf/README.md)。依赖和共享入口按合并顺序接入，后续线保留已有 PDF 翻译导入与 CSP 的本地 Worker/WASM 声明。

## 验收

`node scripts/check-file-preview.mjs`：生产构建 + CSP，隔离 headless Chrome for Testing 的真实文件面板，六套外观、窄布局、Markdown/相对图/Mermaid/恶意 SVG、重复切换释放。没有可见窗口。报告与截图在本工作树 `.local/file-preview-check/<运行>/`。

`packages/device/test/file-preview.test.mts` 验证真实文件/套接字、普通 fs 行为、限额和真实路径；核心 `file-preview.test.mts` 验能力/请求/错误边界；UI `preview.test.mjs` 验解码前格式/尺寸与资源预算。新增格式必须补损坏、主动内容、超限、取消、刷新和释放用例。

`node scripts/check-file-preview-ssh.mjs`：回环 sshd 和隔离的设备聚合面/单入口，验证文件内容、限量和越根错误；不用真实设备或个人 SSH 配置，不起窗口。
