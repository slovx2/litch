// biome-ignore-all lint/suspicious/noArrayIndexKey: 差异的行是定死的一串，位置就是身份
import { diffLines, type FileChangeEntry } from '@litch/core'
import { memo, useMemo } from 'react'
import { useT } from '../app/appearance.ts'
import { openDiffAt } from '../diff/state.ts'
import { byteSize } from '../files/lines.ts'

/** 行内最多画这么多行。再长的差异要到差异面板里看，这里只给摘要和去那边的入口 */
const MAX_LINES = 400

const SIGN = { add: '+', del: '−', ctx: '', hunk: '' } as const

/**
 * 一个文件的差异：行号、增删标记、内容。纯文本着色，放在固定高度的框里。
 * 太长的差异核心只留了头尾（@litch/core 的 text/diff.mts），省掉的地方单独一行写明省了几行、多大
 */
export const Diff = memo(function Diff({ change }: { change: FileChangeEntry }) {
  const lines = useMemo(() => diffLines(change), [change])
  const t = useT()
  if (lines.length === 0) return <div className="diff-note">{t('diff.empty')}</div>
  if (lines.length > MAX_LINES) {
    // 说的是整个差异有几行：省掉的也算上
    const total = lines.length - (change.elided ? 1 : 0) + (change.elided?.lines ?? 0)
    return (
      <div className="diff-note">
        {t('diff.tooLong', { n: total })}
        <button
          type="button"
          className="diff-open"
          data-path={change.movedTo ?? change.path}
          onClick={() => openDiffAt(change.movedTo ?? change.path)}
        >
          {t('change.openDiff')}
        </button>
      </div>
    )
  }
  return (
    <div className="diff">
      {lines.map((line, index) =>
        line.type === 'gap' ? (
          <div key={index} className="dl gap">
            {t('diff.elided', { n: line.lines, size: byteSize(line.bytes) })}
          </div>
        ) : line.type === 'hunk' ? (
          <div key={index} className="dl hunk">
            {line.text}
          </div>
        ) : (
          <div key={index} className={`dl ${line.type}`}>
            <span className="ln">{line.oldNo ?? ''}</span>
            <span className="ln">{line.newNo ?? ''}</span>
            <span className="sg">{SIGN[line.type]}</span>
            <span className="tx">{line.text}</span>
          </div>
        ),
      )}
    </div>
  )
})
