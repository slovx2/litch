// 近 24 小时预览的结果：会进入、会被挡下的样例与诊断（没查全的范围）。不写 GitHub、不移动水位、不启动模型。
import type { ExternalCommands } from '../../../core/src/projection/external.mts'
import { useT } from '../app/appearance.ts'
import { Stamp } from '../transcript/Stamp.tsx'
import { knownReason, subjectLabel } from './model.ts'
import { ExtLink } from './parts.tsx'
import { Diagnostic } from './RepoDetail.tsx'

export type PreviewValue = ExternalCommands['external.source.preview']['result']

export function PreviewResult({ value }: { value: PreviewValue }) {
  const t = useT()
  const blocked = value.matches.filter((one) => one.status === 'blocked')
  const passed = value.matches.length - blocked.length
  return (
    <div className="ext-sub" data-ext-preview>
      <div className="ext-sub-head">
        <span>{t('ext.preview.title')}</span>
        <span className="dim">
          {t('ext.preview.counts', {
            pass: passed,
            blocked: blocked.length,
            gaps: value.diagnostics.filter((one) => one.state !== 'ok').length,
          })}
        </span>
      </div>
      {value.matches.length ? (
        <ul className="ext-diags">
          {value.matches.slice(0, 8).map((one) => (
            <li key={one.eventKey} className="ext-diag" data-preview={one.status}>
              <span className="mono">{subjectLabel(one.subject)}</span>
              <span>{t(`ext.kind.${one.kind}`)}</span>
              <span className="dim">
                {one.status === 'blocked'
                  ? reasonText(t, one.reason)
                  : t(`ext.status.${one.status}`)}
              </span>
              <Stamp className="dim" at={one.occurredAt * 1000} />
              <ExtLink url={one.eventUrl} />
            </li>
          ))}
        </ul>
      ) : (
        <div className="ext-empty">{t('ext.preview.none')}</div>
      )}
      {value.diagnostics.length ? (
        <ul className="ext-diags">
          {value.diagnostics.map((item) => (
            <Diagnostic key={`${item.check}:${item.code}`} item={item} />
          ))}
        </ul>
      ) : null}
    </div>
  )
}

export function reasonText(t: ReturnType<typeof useT>, reason: string | undefined): string {
  const known = knownReason(reason)
  return known ? t(`ext.reason.${known}`) : (reason ?? '')
}
