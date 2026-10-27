// 添加项目时浏览设备上的目录（folders.list）：远程设备没有系统的选文件夹对话框，在对话框里一层层点进去。
// 走到哪一层就把哪一层填进目录那一栏；隐藏的目录（以点开头）不列，要的话自己在栏里填。
import type { FolderListing } from '@litch/core'
import { useEffect, useState } from 'react'
import { useT } from '../app/appearance.ts'
import { reasonOf } from '../app/errors.ts'
import { useServices } from '../app/services.tsx'

interface FolderPickerProps {
  deviceId: string
  /** 从哪一层开始：栏里填的绝对路径；没填（或不是绝对路径）是 null，从设备的主目录开始 */
  start: string | null
  /** 走到了一层：把它填进目录那一栏 */
  onPick(path: string): void
  onClose(): void
}

type State =
  | { kind: 'loading'; path: string | null }
  | { kind: 'ready'; listing: FolderListing }
  | { kind: 'failed'; path: string | null; reason: string }

/** 列出来的下一层的完整路径 */
const childOf = (path: string, name: string): string =>
  path.endsWith('/') ? `${path}${name}` : `${path}/${name}`

export function FolderPicker({ deviceId, start, onPick, onClose }: FolderPickerProps) {
  const { channel } = useServices()
  const t = useT()
  const [target, setTarget] = useState<string | null>(start)
  const [state, setState] = useState<State>({ kind: 'loading', path: start })

  // biome-ignore lint/correctness/useExhaustiveDependencies: onPick 每次渲染都是新的，只在换层时去问
  useEffect(() => {
    const controller = new AbortController()
    setState({ kind: 'loading', path: target })
    channel
      .command('folders.list', { deviceId, path: target }, { signal: controller.signal })
      .then((listing) => {
        setState({ kind: 'ready', listing })
        onPick(listing.path)
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return
        setState({ kind: 'failed', path: target, reason: reasonOf(error, t) })
      })
    return () => controller.abort()
  }, [channel, deviceId, target, t])

  const listing = state.kind === 'ready' ? state.listing : null
  const shown = listing?.path ?? (state.kind === 'ready' ? null : state.path)
  const folders = listing?.folders.filter((name) => !name.startsWith('.')) ?? []

  return (
    <section className="ws-picker" aria-label={t('workspace.browse.label')}>
      <div className="ws-picker-head">
        <button
          type="button"
          className="btn"
          disabled={!listing?.parent}
          onClick={() => listing?.parent && setTarget(listing.parent)}
        >
          {t('workspace.browse.up')}
        </button>
        <span className="mono ell grow" title={shown ?? undefined}>
          {shown ?? '~'}
        </span>
        <button type="button" className="btn" onClick={onClose}>
          {t('workspace.browse.done')}
        </button>
      </div>
      {state.kind === 'loading' ? (
        <div className="form-note ws-picker-note">{t('workspace.browse.loading')}</div>
      ) : state.kind === 'failed' ? (
        <div className="form-note err ws-picker-note">
          {t('workspace.browse.failed', { reason: state.reason })}
          {state.path !== null ? (
            <button type="button" className="btn" onClick={() => setTarget(null)}>
              {t('workspace.browse.home')}
            </button>
          ) : null}
        </div>
      ) : folders.length === 0 ? (
        <div className="form-note ws-picker-note">{t('workspace.browse.empty')}</div>
      ) : (
        <ul className="ws-roots ws-picker-list">
          {folders.map((name) => (
            <li key={name}>
              <button
                type="button"
                className="ws-root"
                onClick={() => listing && setTarget(childOf(listing.path, name))}
              >
                <span className="mono ell">{name}/</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
