// 信息栏里的工作树卡片：会话在设备层建的工作树里时出来。写分支、起点、工作树路径；
// 能复制路径、打开终端（终端本来就以会话目录为根）；目录被删了的（改动留了快照）能建回来。
import type { SessionWorktreeView } from '@litch/core'
import { useState } from 'react'
import { useT } from '../app/appearance.ts'
import { Caret, Icon } from '../app/icons.tsx'
import { useServices } from '../app/services.tsx'
import { setPanelOpen } from '../terminal/panel.ts'
import { useToggle } from '../transcript/state.ts'
import { baseName } from './labels.ts'

export function RailWorktree({
  deviceId,
  sessionKey,
  worktree,
}: {
  deviceId: string
  sessionKey: string
  worktree: SessionWorktreeView
}) {
  const t = useT()
  const { channel } = useServices()
  const [open, setOpen] = useToggle(sessionKey, 'rail:worktree', true)
  const [copied, setCopied] = useState(false)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const removed = worktree.state === 'removed'
  const copy = () => {
    navigator.clipboard.writeText(worktree.path).then(
      () => {
        setCopied(true)
        window.setTimeout(() => setCopied(false), 1500)
      },
      () => {},
    )
  }
  const restore = () => {
    setBusy(true)
    setFailure(null)
    channel
      .command('worktree.restore', { deviceId, id: worktree.id })
      .catch((error: unknown) => setFailure(error instanceof Error ? error.message : String(error)))
      .finally(() => setBusy(false))
  }
  return (
    <section
      className="rail-card rail-worktree"
      data-open={open ? '' : undefined}
      data-state={worktree.state}
    >
      <button
        type="button"
        className="rail-head"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span className="rail-title">{t('worktree.title')}</span>
        <Caret />
        {/* 收着的时候摘要写分支；打开了下面有，不再写一遍 */}
        {open ? null : <span className="rail-sum mono ell">{worktree.branch}</span>}
      </button>
      {open ? (
        <div className="rail-body">
          <dl className="info-facts">
            <div>
              <dt>{t('worktree.branch')}</dt>
              <dd className="mono">{worktree.branch}</dd>
            </div>
            <div>
              <dt>{t('worktree.base')}</dt>
              <dd className="mono">{baseName(worktree.baseRef, t)}</dd>
            </div>
            <div>
              <dt>{t('info.path')}</dt>
              <dd className="mono info-path">{worktree.path}</dd>
            </div>
          </dl>
          {removed ? <p className="rail-note">{t('worktree.removedNote')}</p> : null}
          {failure ? <p className="rail-note err">{failure}</p> : null}
          <div className="rail-acts">
            {removed ? (
              <button
                type="button"
                className="btn"
                data-act="worktree-restore"
                disabled={busy}
                onClick={restore}
              >
                {t(busy ? 'worktree.restoring' : 'worktree.restore')}
              </button>
            ) : (
              <button
                type="button"
                className="btn ghost"
                data-act="worktree-terminal"
                onClick={() => setPanelOpen(true)}
              >
                <Icon name="term" small />
                {t('worktree.terminal')}
              </button>
            )}
            <button type="button" className="btn ghost" data-act="worktree-copy" onClick={copy}>
              <Icon name="copy" small />
              {t(copied ? 'worktree.copied' : 'worktree.copyPath')}
            </button>
          </div>
        </div>
      ) : null}
    </section>
  )
}
