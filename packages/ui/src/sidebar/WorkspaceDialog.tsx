// 添加一个工作区，或者改一个工作区的名字和颜色。
// 工作区是设备上的一条记录（名字 + 目录），不是磁盘上的东西：这里不建目录、不删目录。
import { WIRES, type WireColor, type WorkspaceView } from '@litch/core'
import { type FormEvent, useEffect, useRef, useState } from 'react'
import { useT } from '../app/appearance.ts'
import { wireStyle } from '../app/device.ts'
import { reasonOf } from '../app/errors.ts'
import { useServices } from '../app/services.tsx'

interface WorkspaceDialogProps {
  deviceId: string
  /** 给了就是改这个工作区，不是添加 */
  workspace: WorkspaceView | null
  /** 添加成了：新工作区的标识。在关掉之前叫 */
  onAdded?(workspaceId: string): void
  onClose(): void
}

/** 路径的最后一段，拿来当默认的名字 */
const baseOf = (path: string): string =>
  path
    .replace(/[\\/]+$/, '')
    .split(/[\\/]/)
    .pop() ?? ''

export function WorkspaceDialog({ deviceId, workspace, onAdded, onClose }: WorkspaceDialogProps) {
  const { channel } = useServices()
  const t = useT()
  const dialog = useRef<HTMLDialogElement>(null)
  const [name, setName] = useState(workspace?.name ?? '')
  const [root, setRoot] = useState('')
  const [color, setColor] = useState<WireColor | null>(workspace?.color ?? null)
  /** 可以直接挑的目录：还没归进工作区的会话用过的。只在添加时去问 */
  const [candidates, setCandidates] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const adding = workspace === null

  // 用模态方式打开：焦点留在里面，Esc 由浏览器处理
  useEffect(() => {
    const element = dialog.current
    if (element && !element.open) element.showModal()
  }, [])

  useEffect(() => {
    if (!adding) return
    const controller = new AbortController()
    channel
      .command('workspace.candidates', { deviceId }, { signal: controller.signal })
      .then(({ roots }) => setCandidates(roots))
      // 问不到就没有候选，自己填路径不受影响
      .catch(() => {})
    return () => controller.abort()
  }, [channel, deviceId, adding])

  const title = t(adding ? 'workspace.add.title' : 'workspace.edit.title')
  const path = root.trim()
  const named = name.trim() || (adding ? baseOf(path) : '')
  const ready = adding ? path.length > 0 && named.length > 0 : named.length > 0

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!ready || busy) return
    setBusy(true)
    setFailure(null)
    const done = adding
      ? channel
          .command('workspace.create', { deviceId, name: named, root: path, color })
          .then(({ workspaceId }) => onAdded?.(workspaceId))
      : channel.command('workspace.update', {
          deviceId,
          workspaceId: workspace.id,
          // 没动的不发：别处刚改过的不会被这边的旧值盖回去
          ...(named !== workspace.name ? { name: named } : {}),
          ...(color !== workspace.color ? { color } : {}),
        })
    done.then(onClose, (error: unknown) => {
      setBusy(false)
      setFailure(t('session.failed', { reason: reasonOf(error, t) }))
    })
  }

  return (
    <dialog
      ref={dialog}
      className="modal ws-dialog"
      aria-label={title}
      onClose={onClose}
      onKeyDown={(event) => {
        // Esc 只关这个对话框，别让外面的 Esc 处理也跟着动
        if (event.key === 'Escape') event.stopPropagation()
      }}
    >
      <form onSubmit={submit}>
        <div className="modal-head">
          <span className="grow">{title}</span>
        </div>
        <div className="modal-body">
          {adding ? (
            <div className="form-field">
              <label className="form-label" htmlFor="ws-root">
                {t('workspace.root')}
              </label>
              <input
                id="ws-root"
                className="req-input mono"
                value={root}
                placeholder="/home/me/project"
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
                autoFocus
                onChange={(event) => setRoot(event.target.value)}
              />
              <span className="form-note">{t('workspace.root.hint')}</span>
              {candidates.length > 0 ? (
                <ul className="ws-roots" aria-label={t('workspace.root.candidates')}>
                  <li className="form-note">{t('workspace.root.candidates')}</li>
                  {candidates.map((candidate) => (
                    <li key={candidate}>
                      <button
                        type="button"
                        className={candidate === path ? 'ws-root on' : 'ws-root'}
                        aria-pressed={candidate === path}
                        onClick={() => setRoot(candidate)}
                      >
                        <span className="mono ell">{candidate}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : (
            <div className="form-field">
              <span className="form-label">{t('workspace.root')}</span>
              <span className="mono ws-fixed">{workspace.roots.join('\n')}</span>
              <span className="form-note">{t('workspace.root.fixed')}</span>
            </div>
          )}
          <div className="form-field">
            <label className="form-label" htmlFor="ws-name">
              {t('workspace.name')}
            </label>
            <input
              id="ws-name"
              className="req-input"
              value={name}
              placeholder={adding ? baseOf(path) : undefined}
              autoComplete="off"
              spellCheck={false}
              autoFocus={!adding}
              onChange={(event) => setName(event.target.value)}
            />
            {adding ? <span className="form-note">{t('workspace.name.hint')}</span> : null}
          </div>
          <div className="form-field">
            <span className="form-label">{t('workspace.color')}</span>
            <span className="wires ws-colors" role="radiogroup" aria-label={t('workspace.color')}>
              {/* biome-ignore lint/a11y/useSemanticElements: 原生的单选框画不成一排色块 */}
              <button
                type="button"
                role="radio"
                className="none"
                aria-checked={color === null}
                aria-label={t('workspace.color.none')}
                title={t('workspace.color.none')}
                onClick={() => setColor(null)}
              />
              {WIRES.map((wire) => (
                // biome-ignore lint/a11y/useSemanticElements: 原生的单选框画不成一排色块
                <button
                  key={wire}
                  type="button"
                  role="radio"
                  aria-checked={wire === color}
                  aria-label={wire}
                  title={wire}
                  style={wireStyle(wire)}
                  onClick={() => setColor(wire)}
                />
              ))}
            </span>
          </div>
          {failure ? <div className="modal-note err">{failure}</div> : null}
        </div>
        <div className="modal-foot">
          <span className="grow" />
          <button type="button" className="btn" onClick={onClose}>
            {t('workspace.cancel')}
          </button>
          <button type="submit" className="btn primary" disabled={!ready || busy}>
            {t(adding ? 'workspace.create' : 'workspace.save')}
          </button>
        </div>
      </form>
    </dialog>
  )
}
