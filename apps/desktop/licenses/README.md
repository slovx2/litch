# 预构建浏览器依赖的许可

常规 npm 包由 `scripts/licenses.mjs` 从安装目录收集；这里补充发布包漏带的许可，和包内预构建产物已经内嵌的依赖。

- `exceljs-4.4.0-browser.txt`：ExcelJS 4.4.0 官方 npm 浏览器产物的 source map 列出 68 个包（包括打包器前导代码）。逐包保留版权/许可原文；生成依据在 `exceljs-4.4.0-sources.json`。引用版本用于定位许可原文，不声称重建出官方预构建时的完整依赖锁。JS 产物由 npm integrity 与 SHA-256 固定，许可收集时核验 SHA-256，升级不能沿用旧声明。
- ExcelJS 的 Node 入口另依赖 archiver/unzipper 等，与浏览器产物不同。应用没有打包该入口，不将其依赖树误当成浏览器内嵌包清单。普通依赖仍按实际安装位置遍历。
- `saxes-5.0.1.txt`：npm 包未附独立 LICENSE，从官方 v5.0.1 标签保留全文，包含 sax 的原始声明。ISC。
- `isarray-1.0.0.txt`：对应 npm README 的完整 License 节；MIT。

ExcelJS 内嵌模块的源码只用于核对清单，未另行复制其代码。所有文本随应用的 `licenses/` 目录分发。JSZip 采用 MIT 选项；DOMPurify 采用 Apache-2.0 选项。
