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
          {result.attempted.length
            ? result.attempted.map((path) => <div key={path}>{path}</div>)
            : t('files.link.notAttempted')}
        </dd>
      </dl>
      {result.failures.length > 0 ? (
        <ul>
          {result.failures.map((failure) => (
            <li key={failure.path}>
              {failure.path} · {t(`files.link.error.${failure.reason}`)}
            </li>
          ))}
        </ul>
      ) : null}
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
