# Office 只读预览

`renderers/docx.tsx`、`renderers/xlsx.tsx` 沿用共用预览契约，仅消费已经受限读取的 bytes。不得自行读取路径或网络。手机、协议、共用文件面板不变。

## 边界

- `archive.ts`：10 MiB 输入，目录总展开 40 MiB，最多 2,048 项。拒绝加密、ZIP64、非 STORE/DEFLATE、重复/越界路径和重叠区段。逐项 `DecompressionStream` 解压，逐块计真实长度，超过预算/声明即停；CRC 和真实长度通过后才交给库。不把 JSZip 的全量 load 或 Promise 超时当作解压预算。
- `xml.ts`：Saxes 不建 DOM 的预检，禁实体/DOCTYPE/处理指令，节点总量与深度预算；工作表属性用真实 XML 解析，不能用正则猜引号与实体边界。
- DOCX：ZIP Worker 先验包；`docx-frame.ts?worker&url` 编成独立经典脚本，运行于 `sandbox="allow-scripts"` 的 opaque-origin srcdoc。CSP 只允许该构建脚本 URL，禁 inline script、网络、字体、嵌套 frame、对象、表单；没有同源、弹窗或顶层导航权限。一次性 MessagePort 传已验 parts，没有应用服务或 preload。移除外部 relationships、altChunk、嵌入对象、内嵌字体；图片不按目录猜，所有允许二进制都核格式/尺寸，最多 16 张/累计 40M 像素。库输出先在 detached DOM 中经 DOMPurify，再放到 iframe。正常100%文档尺寸，窄面板可横向滚动，版式近似。
- XLSX：独立 Worker 中使用 ExcelJS 官方浏览器包；只向库传核验后的 STORE 包。加载前限制 100,000 单元格（合并展开也计入）、100 sheet、1,000 合并范围、每表 10,000 行/200 列，拒绝超限而非先完整装载再截断。图片、绘图、externalLinks 不交给解析库。返回文本和合并范围，DOM 仅挂可见网格。公式只读缓存，无缓存显示公式；链接作为文本；日期支持1900/1904，数值支持常见十进制/千分位/百分比，复杂自定义格式显示原值。
- 一个文件一个 Worker，结果/错误/15秒超时/切换立即 terminate；iframe 卸载即销毁整份文档，使用内联图片数据，不保留 Blob URL。DOCX iframe 是独立文档安全边界，渲染复杂度有上限；不承诺与 Word 分页/字体完全一致。

## 依赖与验收

UI 直接依赖版本固定在 package.json，安装树固定在 lock。DOCX Apache-2.0、JSZip 选 MIT、DOMPurify 选 Apache-2.0、ExcelJS MIT、Saxes ISC。ExcelJS 预构建包内嵌的包不能只按 Node dependencies 收许可；`apps/desktop/licenses/` 中按 source map 记录全部内嵌包，收集器核 bundle 哈希后附上完整 notices。

- `node --test packages/ui/test/office.test.mjs`：炸弹（声明/实际）、CRC/路径、宏/实体、XML深度、坐标/合并/单元格预算、日期/字符串/公式。
- `node scripts/check-office-preview.mjs`：生产构建/CSP + headless Chrome，真实文件面板；opaque父页隔离、脚本/事件不执行、外链不请求、页眉页脚、虚拟滚动、sheet切换、取消释放、三皮肤深浅及760宽。报告在 `.local/office-preview-check/`。
- `node scripts/check-office-electron.mjs <上一步的assets目录>`：macOS 隐藏 Electron，真实 `app://ui` 加载。自动编译无窗口采样器，启动前/运行中查可见窗口和焦点，出现测试窗口立即终止进程树；只用临时 HOME/profile，退出检查残留。跑前仍遵守本机前台协调要求。

解析补充：XLSX 的命名区域、数据验证、列定义和打印范围也可能引发 ExcelJS 扩展出巨大集合；因此在交库前用 SAX 删除这些不用于文字预览的子树，只提供 workbook/styles/sharedStrings/worksheet 等必要部件。sheetId 限于1–1000且不重复。单元格输出另按 UTF-16 文本累计计8 MiB，防止100,000个单元格反复引用同一条大 sharedString。ZIP 压缩输入每次只喂1 KiB，解码器不能在下一次JS计数前展开整块压缩数据。
