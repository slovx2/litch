import '../src/styles/index.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { setAppearance } from '../src/app/appearance.ts'
import { MermaidBlock } from '../src/transcript/Mermaid.tsx'

const source = `flowchart LR
  A["收集需求<br/>确认使用场景"] --> B["梳理现状<br/>记录复现步骤"]
  B --> C["核对输入<br/>补充测试样例"]
  C --> D["实现修复<br/>检查边界条件"]
  D --> E["桌面验收<br/>验证深浅外观"]
  E --> F["检查结果<br/>整理证据与截图"]
  F --> G["提交审查<br/>等待集成确认"]`

setAppearance({ skin: 'standard', theme: 'light', lang: 'zh-CN' })
const root = document.getElementById('root')
if (!root) throw new Error('缺少挂载点')
createRoot(root).render(
  <StrictMode>
    <main className="tr" style={{ margin: '24px auto', width: 'min(760px, 90vw)' }}>
      <div className="md">
        <MermaidBlock text={source} open={false} />
      </div>
    </main>
  </StrictMode>,
)
