// 给文件内容上色的工作线程。上色库是同步的，几千行的文件要算上好一阵：放在这里算，界面那边照常滚、照常点。
// 算完按行切开，一批一批送回去——界面只画看得见的行，先到的先用。
// 这里只出“带类名的片段”和文字（core 的 parseSpans），不出 HTML：界面照着它生成元素，不往页面里塞标记。
import { parseSpans, splitSpanLines } from '@litch/core'
import hljs from 'highlight.js/lib/common'
import type { PaintReply, PaintRequest } from './paint-types.ts'

/** 一批送多少行 */
const BATCH = 500

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<PaintRequest>) => void) | null
  postMessage(message: PaintReply): void
}

scope.onmessage = (event) => {
  const { id, text, language } = event.data
  if (!hljs.getLanguage(language)) {
    scope.postMessage({ id, done: true, painted: false })
    return
  }
  const html = hljs.highlight(text, { language, ignoreIllegals: true }).value
  const lines = splitSpanLines(parseSpans(html))
  for (let from = 0; from < lines.length; from += BATCH) {
    scope.postMessage({ id, from, lines: lines.slice(from, from + BATCH) })
  }
  scope.postMessage({ id, done: true, painted: true })
}
