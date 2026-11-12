import type { FileLinkResolution } from '@litch/core'
import { useT } from '../app/appearance.ts'
import { runFileAction } from './actions.ts'

export function FileLinkDetails({
  result,
  expanded = false,
  copy = true,
}: {
  result: FileLinkResolution
  expanded?: boolean
  copy?: boolean
}) {
  const t = useT()
  // 失败原因并到对应的尝试路径后面，不另列一遍同样的路径
  const reasons = new Map(result.failures.map((failure) => [failure.path, failure.reason]))
  const tried = [
    ...result.attempted,
    ...result.failures.map((failure) => failure.path).filter((path) => !result.attempted.includes(path)),
  ]
  return (
    <details className="file-link-details" open={expanded || undefined}>
      <summary>{t('files.link.details')}</summary>
      <dl>
        <dt>{t('files.link.href')}</dt>
        <dd>{result.href}</dd>
        <dt>{t('files.link.path')}</dt>
        <dd>{result.path || t('files.link.notResolved')}</dd>
        <dt>{t('files.link.attempted')}</dt>
        <dd>
          {tried.length
            ? tried.map((path) => {
                const reason = reasons.get(path)
                return (
                  <div key={path}>
                    {path}
                    {reason ? (
                      <span className="file-link-reason">
                        {' · '}
                        {t(`files.link.error.${reason}`)}
                      </span>
                    ) : null}
                  </div>
                )
              })
            : t('files.link.notAttempted')}
        </dd>
      </dl>
      {copy ? (
        <button
          type="button"
          className="btn"
          onClick={() =>
            runFileAction('copyFull', { path: result.path || result.href, relative: '' })
          }
        >
          {t('files.action.copyFull')}
        </button>
      ) : null}
    </details>
  )
}
