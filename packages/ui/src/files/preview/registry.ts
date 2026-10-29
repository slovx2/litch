import type { PreviewFormat, PreviewLoader, PreviewModule } from './contract.ts'

// 一个格式一个模块。后续新增 pdf/docx/xlsx/csv/html/media.tsx 即注册，不修改中心文件。
// 模块懒加载，不能把 PDF worker 或 Office 库引进首页。
const modules = import.meta.glob<PreviewModule>('./renderers/*.tsx')
export const rendererFor = (format: PreviewFormat): PreviewLoader | undefined =>
  modules[`./renderers/${format}.tsx`]
