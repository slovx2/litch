// 从侧栏的会话菜单里“派一个子会话…”：挑 harness、模型、项目，全新开始还是带上父会话的上下文
// （带上下文只能用父会话的 harness），写第一段话，勾不勾“完成后唤醒主会话”。派出去由设备进程做。
import {
  type DeviceView,
  keys,
  type LineageKind,
  type SessionSummary,
  type WorkspaceView,
} from '@litch/core'
import { type FormEvent, useEffect, useRef, useState } from 'react'
import { useT } from '../app/appearance.ts'
import { reasonOf } from '../app/errors.ts'
import { useKey, useServices } from '../app/services.tsx'
import { useComposeOptions } from '../composer/SettingsBar.tsx'

interface SpawnDialogProps {
  deviceId: string
  parent: SessionSummary
  /** 派出去了：子会话的标识。在关掉之前叫 */
  onSpawned(sessionId: string): void
  onClose(): void
}

const NO_WORKSPACES: readonly WorkspaceView[] = []

export function SpawnDialog({ deviceId, parent, onSpawned, onClose }: SpawnDialogProps) {
  const { channel } = useServices()
  const t = useT()
  const dialog = useRef<HTMLDialogElement>(null)
  const device = useKey<DeviceView>(keys.device(deviceId))
  const workspaces = useKey<WorkspaceView[]>(keys.workspaces(deviceId)) ?? NO_WORKSPACES
  const ready = (device?.harnesses ?? []).filter((entry) => entry.state === 'ready')
  const [harness, setHarness] = useState(parent.harness)
  const [model, setModel] = useState('')
  const [workspaceId, setWorkspaceId] = useState(parent.workspaceId ?? '')
  const [kind, setKind] = useState<LineageKind>('fresh')
  const [title, setTitle] = useState('')
  const [prompt, setPrompt] = useState('')
  const [wake, setWake] = useState(true)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const options = useComposeOptions(deviceId, harness)
  const models = options?.models ?? []
  // 带上下文只能同一个 harness：换了别的就退回全新开始
  const sameHarness = harness === parent.harness
  const shownKind: LineageKind = sameHarness ? kind : 'fresh'

  useEffect(() => {
    const element = dialog.current
    if (element && !element.open) element.showModal()
  }, [])

  const text = prompt.trim()
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!text || busy) return
    setBusy(true)
    setFailure(null)
    channel
      .command('session.spawn', {
        deviceId,
        parentId: parent.id,
        kind: shownKind,
        title: title.trim(),
        prompt: text,
        wakeParent: wake,
        ...(harness !== parent.harness ? { harness } : {}),
        ...(model ? { model } : {}),
        ...(workspaceId && workspaceId !== parent.workspaceId ? { workspaceId } : {}),
      })
      .then(({ sessionId }) => {
        onSpawned(sessionId)
        onClose()
      })
      .catch((error: unknown) => {
        setBusy(false)
        setFailure(t('session.failed', { reason: reasonOf(error, t) }))
      })
  }

  return (
    <dialog
      ref={dialog}
      className="modal ws-dialog spawn-dialog"
      aria-label={t('tree.dialog.title')}
      onClose={onClose}
      onKeyDown={(event) => {
        if (event.key === 'Escape') event.stopPropagation()
      }}
    >
      <form onSubmit={submit}>
        <div className="modal-head">
          <span className="grow">{t('tree.dialog.title')}</span>
        </div>
        <div className="modal-body">
          <div className="form-field">
            <span className="form-label">{t('tree.lineage.before')}</span>
            <span className="ell">{t.text(parent.title)}</span>
          </div>
          <div className="form-field spawn-row">
            <label className="form-label" htmlFor="spawn-harness">
              {t('tree.dialog.harness')}
            </label>
            <select
              id="spawn-harness"
              className="req-input"
              value={harness}
              onChange={(event) => {
                setHarness(event.target.value)
                setModel('')
              }}
            >
              {ready.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.name}
                </option>
              ))}
            </select>
          </div>
          <div className="form-field spawn-row">
            <label className="form-label" htmlFor="spawn-model">
              {t('tree.dialog.model')}
            </label>
            <select
              id="spawn-model"
              className="req-input"
              value={model}
              onChange={(event) => setModel(event.target.value)}
            >
              <option value="">{t('tree.dialog.modelDefault')}</option>
              {models.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.title}
                </option>
              ))}
            </select>
          </div>
          {workspaces.length > 0 ? (
            <div className="form-field spawn-row">
              <label className="form-label" htmlFor="spawn-workspace">
                {t('tree.dialog.workspace')}
              </label>
              <select
                id="spawn-workspace"
                className="req-input"
                value={workspaceId}
                onChange={(event) => setWorkspaceId(event.target.value)}
              >
                <option value="">{t('workspace.none')}</option>
                {workspaces.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.name}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
          <fieldset className="form-field spawn-kind">
            <legend className="form-label">{t('tree.dialog.kind')}</legend>
            <label>
              <input
                type="radio"
                name="spawn-kind"
                value="fresh"
                checked={shownKind === 'fresh'}
                onChange={() => setKind('fresh')}
              />
              {t('tree.dialog.fresh')}
            </label>
            <label className={sameHarness ? undefined : 'off'}>
              <input
                type="radio"
                name="spawn-kind"
                value="fork"
                checked={shownKind === 'fork'}
                disabled={!sameHarness}
                onChange={() => setKind('fork')}
              />
              {t('tree.dialog.fork')}
            </label>
            {sameHarness ? null : <span className="form-note">{t('tree.dialog.forkOnly')}</span>}
          </fieldset>
          <div className="form-field">
            <label className="form-label" htmlFor="spawn-title">
              {t('tree.dialog.name')}
            </label>
            <input
              id="spawn-title"
              className="req-input"
              value={title}
              autoComplete="off"
              placeholder={t('tree.dialog.nameHint')}
              onChange={(event) => setTitle(event.target.value)}
            />
          </div>
          <div className="form-field">
            <label className="form-label" htmlFor="spawn-prompt">
              {t('tree.dialog.prompt')}
            </label>
            <textarea
              id="spawn-prompt"
              className="req-input spawn-prompt"
              value={prompt}
              rows={4}
              autoFocus
              onChange={(event) => setPrompt(event.target.value)}
            />
          </div>
          <label className="spawn-wake">
            <input
              type="checkbox"
              checked={wake}
              onChange={(event) => setWake(event.target.checked)}
            />
            {t('tree.dialog.wake')}
          </label>
          {failure ? <div className="modal-note err">{failure}</div> : null}
        </div>
        <div className="modal-foot">
          <span className="grow" />
          <button type="button" className="btn" onClick={onClose}>
            {t('tree.dialog.cancel')}
          </button>
          <button type="submit" className="btn primary" disabled={!text || busy}>
            {t('tree.dialog.start')}
          </button>
        </div>
      </form>
    </dialog>
  )
}
