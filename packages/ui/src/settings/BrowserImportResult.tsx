// 导入对话框（BrowserImportDialog.tsx）的后两屏：逐类进度，逐类结果；以及两屏共用的小块。
// 结果怎么说、什么颜色、能不能重试由 browser-import-logic.ts 的 reportOf 定，这里只画。
import { useT } from '../app/appearance.ts'
import { Check } from '../app/icons.tsx'
import type { MessageKey } from '../i18n/index.ts'
import type { ImportKind, ImportOutcome, ImportRequest } from '../side/browser/bridge.ts'
import {
  KINDS,
  type KindReport,
  type KindStage,
  reportOf,
  STAGE_TEXT,
  showsCounts,
} from './browser-import-logic.ts'

export const KIND_TEXT: Record<ImportKind, MessageKey> = {
  cookies: 'bimport.kind.cookies',
  passwords: 'bimport.kind.passwords',
}

/** 逐类进度：等待、正在读取、正在写入、完成 */
export function ImportProgressView({
  name,
  stages,
  stopping,
}: {
  name: string
  stages: Partial<Record<ImportKind, KindStage>>
  stopping: boolean
}) {
  const t = useT()
  return (
    <div className="modal-body bimp-progress" aria-busy="true">
      <p className="bimp-lead" role="status">
        {t(stopping ? 'bimport.stopping' : 'bimport.running', { name })}
      </p>
      <ul className="bimp-lines">
        {KINDS.filter((kind) => stages[kind] !== undefined).map((kind) => {
          const stage = stages[kind] as KindStage
          return (
            <li key={kind} className="bimp-line" data-kind={kind} data-stage={stage}>
              <span className="bimp-mark" aria-hidden="true">
                {stage === 'done' ? <Check /> : null}
              </span>
              <span className="bimp-line-name">{t(KIND_TEXT[kind])}</span>
              <span className="bimp-line-say">{t(STAGE_TEXT[stage])}</span>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

/** 逐类结果 */
export function ImportResultView({
  name,
  origin,
  outcome,
  stopped,
}: {
  name: string
  origin: ImportRequest
  outcome: ImportOutcome
  /** 用户点过“停止导入” */
  stopped: boolean
}) {
  const t = useT()
  const report = reportOf(origin.kinds, outcome, stopped)
  return (
    <div className="modal-body bimp-result" data-overall={report.overall}>
      <p className="bimp-lead" role="status" data-tone={toneOfOverall(report.overall)}>
        {t(report.say)}
      </p>
      {report.kinds.length > 0 ? (
        <ul className="bimp-lines">
          {report.kinds.map((line) => (
            <ResultLine key={line.kind} line={line} name={name} />
          ))}
        </ul>
      ) : null}
    </div>
  )
}

const toneOfOverall = (overall: string) =>
  overall === 'ok'
    ? 'ok'
    : overall === 'existing' || overall === 'nothing'
      ? 'quiet'
      : overall === 'partial' || overall === 'cancelled'
        ? 'warn'
        : 'err'

function ResultLine({ line, name }: { line: KindReport; name: string }) {
  const t = useT()
  // 导入的数一直写；已存在、无效、失败有才写
  const counts: [MessageKey, number][] = [
    ['bimport.count.imported', line.imported],
    ['bimport.count.existing', line.skippedExisting],
    ['bimport.count.invalid', line.skippedInvalid],
    ['bimport.count.failed', line.failed],
  ]
  // 停下的那一类也写：已经写进去的条数要看得到
  const worked = showsCounts(line)
  return (
    <li
      className="bimp-line"
      data-kind={line.kind}
      data-status={line.status}
      data-tone={line.tone}
      data-imported={line.imported}
      data-existing={line.skippedExisting}
      data-invalid={line.skippedInvalid}
      data-failed={line.failed}
    >
      <span className="bimp-mark" aria-hidden="true">
        {line.tone === 'ok' ? <Check /> : null}
      </span>
      <span className="bimp-line-name">{t(KIND_TEXT[line.kind])}</span>
      <span className="bimp-line-say">{t(line.say, { name })}</span>
      {worked ? (
        <span className="bimp-counts">
          {counts
            .filter(([key, n]) => key === 'bimport.count.imported' || n > 0)
            .map(([key, n]) => (
              <span
                key={key}
                className="bimp-count"
                data-count={key.slice('bimport.count.'.length)}
              >
                {t(key, { n })}
              </span>
            ))}
          {line.discovered > 0 ? (
            <span className="bimp-count dim">
              {t('bimport.count.found', { n: line.discovered })}
            </span>
          ) : null}
        </span>
      ) : null}
      {line.error ? (
        <details className="bimp-details">
          <summary>{t('bimport.details')}</summary>
          <span className="mono">{line.error}</span>
        </details>
      ) : null}
    </li>
  )
}
