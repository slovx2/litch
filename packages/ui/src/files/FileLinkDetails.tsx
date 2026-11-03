import type { FileLinkResolution } from '@litch/core'
import { useT } from '../app/appearance.ts'
import { runFileAction } from './actions.ts'

export function FileLinkDetails({
  result,
  expanded = false,
}: {
  result: FileLinkResolution
  expanded?: boolean
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
      <button
        type="button"
        className="btn"
        onClick={() =>
          runFileAction('copyFull', { path: result.path || result.href, relative: '' })
        }
      >
        {t('files.action.copyFull')}
      </button>
    </details>
  )
}
