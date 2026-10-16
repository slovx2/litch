import { memo, useEffect, useRef, useState } from 'react'
import { useT } from '../app/appearance.ts'
import { paint, useHighlight } from './highlight.tsx'

interface CodeBlockProps {
  lang: string
  text: string
  anchor?: string | undefined
}

/** 代码块：上面一条写语言和“复制”，下面是代码。围栏上写了语言、上色库又认识的，按语法上色 */
export const CodeBlock = memo(function CodeBlock({ lang, text, anchor }: CodeBlockProps) {
  const [copied, setCopied] = useState(false)
  const timer = useRef(0)
  const t = useT()
  const painted = useHighlight(lang, text)
  useEffect(() => () => window.clearTimeout(timer.current), [])

  const copy = () => {
    navigator.clipboard.writeText(text).then(
      () => {
        setCopied(true)
        window.clearTimeout(timer.current)
        timer.current = window.setTimeout(() => setCopied(false), 1500)
      },
      () => {},
    )
  }

  return (
    <div className="code" data-anchor={anchor}>
      <div className="code-head">
        <span>{lang || t('code.text')}</span>
        <button type="button" className="mini" onClick={copy}>
          {t(copied ? 'code.copied' : 'code.copy')}
        </button>
      </div>
      <pre>
        <code>{paint(text, painted)}</code>
      </pre>
    </div>
  )
})
