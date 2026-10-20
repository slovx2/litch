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

/** 逐类结果。要勾管理员同意才能重试的，勾在这一屏上 */
export function ImportResultView({
  name,
  origin,
  outcome,
  consent,
  onConsent,
}: {
  name: string
  origin: ImportRequest
  outcome: ImportOutcome
  consent: boolean
  onConsent(on: boolean): void
}) {
  const t = useT()
  const report = reportOf(origin.kinds, outcome)
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
      {report.elevate.length > 0 ? (
        <ElevateCheck name={name} checked={consent} onChange={onConsent} />
      ) : null}
    </div>
  )
}

const toneOfOverall = (overall: string) =>
  overall === 'ok' ? 'ok' : overall === 'partial' || overall === 'cancelled' ? 'warn' : 'err'

function ResultLine({ line, name }: { line: KindReport; name: string }) {
  const t = useT()
  // 导入的数一直写；已存在、无效、失败有才写
  const counts: [MessageKey, number][] = [
    ['bimport.count.imported', line.imported],
    ['bimport.count.existing', line.skippedExisting],
    ['bimport.count.invalid', line.skippedInvalid],
    ['bimport.count.failed', line.failed],
  ]
  const worked = line.tone === 'ok' || line.tone === 'warn'
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

/** “允许用管理员权限读取”的勾，表单上和结果页上各用一次 */
export function ElevateCheck({
  name,
  checked,
  onChange,
}: {
  name: string
  checked: boolean
  onChange(on: boolean): void
}) {
  const t = useT()
  return (
    <label className="bimp-kind bimp-elevate">
      <input
        type="checkbox"
        data-field="allow-elevated"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="bimp-kind-text">
        <span>{t('bimport.elevate')}</span>
        <span className="form-note">{t('bimport.elevate.note', { name })}</span>
      </span>
    </label>
  )
}
