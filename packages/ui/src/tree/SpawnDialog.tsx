// 派子会话的弹窗，两种用法共用一张表（表单的初值和提交的内容在 spawn-form.ts）：
// - 从侧栏的会话菜单里“派一个子会话…”：挑 harness、模型、强度、项目、目录、权限，全新开始还是带上父会话的
//   上下文（带上下文只能用父会话的 harness），写标题、任务和背景（全新开始时才有，可不填），勾不勾“完成后唤醒主会话”；
// - 提案卡片上的“改了再开始”：照提案预填，提案没写的模型、强度按父会话此刻的预填，都能改（含“完成后唤醒主会话”），
//   确认后带着改过的那几项开始。
// 派出去、开始都由设备进程做；沙箱收紧到不宽于父会话，目标 harness 收不紧时这里写明。
import {
  type DeviceView,
  keys,
  type SessionProposalView,
  type SessionSettings,
  type SessionSummary,
  type WorkspaceView,
} from '@litch/core'
import { type FormEvent, useEffect, useRef, useState } from 'react'
import { useT } from '../app/appearance.ts'
import { reasonOf } from '../app/errors.ts'
import { useKey, useServices } from '../app/services.tsx'
import { EFFORT_TEXT } from '../composer/efforts.ts'
import { useComposeOptions } from '../composer/SettingsBar.tsx'
import { WorktreeCheck } from '../worktrees/WorktreeCheck.tsx'
import { SANDBOX_CHOICES, SANDBOX_LEVEL, widerLevel } from './sandbox.ts'
import { fieldsFor, kindOf, overridesOf, type SpawnFields, spawnParams } from './spawn-form.ts'

interface SpawnDialogProps {
  deviceId: string
  parent: Pick<SessionSummary, 'id' | 'title' | 'harness' | 'cwd' | 'workspaceId'> & {
    worktree?: object | null
  }
  /** 给了就是“改了再开始”这张提案 */
  proposal?: SessionProposalView
  /** 派出去（开始）了：子会话的标识。在关掉之前叫 */
  onSpawned?(sessionId: string): void
  onClose(): void
}

const NO_WORKSPACES: readonly WorkspaceView[] = []

export function SpawnDialog({ deviceId, parent, proposal, onSpawned, onClose }: SpawnDialogProps) {
  const { channel } = useServices()
  const t = useT()
  const dialog = useRef<HTMLDialogElement>(null)
  const device = useKey<DeviceView>(keys.device(deviceId))
  const workspaces = useKey<WorkspaceView[]>(keys.workspaces(deviceId)) ?? NO_WORKSPACES
  const ready = (device?.harnesses ?? []).filter((entry) => entry.state === 'ready')
  const parentSettings = useKey<SessionSettings>(keys.settings(deviceId, parent.id))
  // 按父会话此刻的模型、强度预填（提案里写了的盖过它）：用户看得到会用什么开
  const [fields, setFields] = useState<SpawnFields>(() =>
    fieldsFor(parent, proposal ?? null, parentSettings),
  )
  const set = (patch: Partial<SpawnFields>) => setFields((now) => ({ ...now, ...patch }))
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const options = useComposeOptions(deviceId, fields.harness)
  const models = options?.models ?? []
  const model = models.find((entry) => entry.id === fields.model)
  // 目标 harness 收不到要的那么严（比如没有沙箱的 Pi）：照常能派，写明子会话会更宽
  const wider = widerLevel(
    parentSettings?.permission,
    (options?.permissions ?? []).map((preset) => preset.id),
    fields.sandbox || null,
  )
  const sameHarness = fields.harness === parent.harness
  const shownKind = kindOf(fields, parent)
  const harnessName = (id: string) => ready.find((entry) => entry.id === id)?.name ?? id

  useEffect(() => {
    const element = dialog.current
    if (element && !element.open) element.showModal()
  }, [])

  const text = fields.prompt.trim()
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!text || busy) return
    setBusy(true)
    setFailure(null)
    const sent = proposal
      ? channel.command('session.proposal.accept', {
          deviceId,
          sessionId: parent.id,
          proposalId: proposal.id,
          overrides: overridesOf(fields, parent, proposal, device?.worktrees === true),
        })
      : channel.command('session.spawn', {
          deviceId,
          parentId: parent.id,
          ...spawnParams(fields, parent, device?.worktrees === true),
        })
    sent
      .then(({ sessionId }) => {
        onSpawned?.(sessionId)
        onClose()
      })
      .catch((error: unknown) => {
        setBusy(false)
        setFailure(t('session.failed', { reason: reasonOf(error, t) }))
      })
  }

  const heading = proposal ? t('proposal.edit.title') : t('tree.dialog.title')
  return (
    <dialog
      ref={dialog}
      className="modal ws-dialog spawn-dialog"
      aria-label={heading}
      data-proposal={proposal?.id}
      onClose={onClose}
      onKeyDown={(event) => {
        if (event.key === 'Escape') event.stopPropagation()
      }}
    >
      <form onSubmit={submit}>
        <div className="modal-head">
          <span className="grow">{heading}</span>
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
              value={fields.harness}
              onChange={(event) => set({ harness: event.target.value, model: '', effort: '' })}
            >
              {/* 提案里写的 harness 现在不可用：照样列出来，选着它开始由设备进程说行不行 */}
              {ready.some((entry) => entry.id === fields.harness) ? null : (
                <option value={fields.harness}>{fields.harness}</option>
              )}
              {ready.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.name}
                </option>
              ))}
            </select>
          </div>
          {wider ? (
            <p className="spawn-wider" data-wider={wider}>
              {t('tree.spawn.wider', {
                harness: harnessName(fields.harness),
                level: t(SANDBOX_LEVEL[wider]),
              })}
            </p>
          ) : null}
          <div className="spawn-pair">
            <div className="form-field spawn-row">
              <label className="form-label" htmlFor="spawn-model">
                {t('tree.dialog.model')}
              </label>
              <select
                id="spawn-model"
                className="req-input"
                value={fields.model}
                onChange={(event) => set({ model: event.target.value, effort: '' })}
              >
                <option value="">{t('tree.dialog.modelDefault')}</option>
                {fields.model && !model ? (
                  <option value={fields.model}>{fields.model}</option>
                ) : null}
                {models.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.title}
                  </option>
                ))}
              </select>
            </div>
            <div className="form-field spawn-row">
              <label className="form-label" htmlFor="spawn-effort">
                {t('tree.dialog.effort')}
              </label>
              <select
                id="spawn-effort"
                className="req-input"
                value={fields.effort}
                disabled={!model || model.efforts.length === 0}
                onChange={(event) => set({ effort: event.target.value })}
              >
                <option value="">{t('tree.dialog.modelDefault')}</option>
                {(model?.efforts ?? []).map((effort) => {
                  const key = EFFORT_TEXT[effort.id]
                  return (
                    <option key={effort.id} value={effort.id}>
                      {key ? t(key) : effort.id}
                    </option>
                  )
                })}
              </select>
            </div>
          </div>
          {workspaces.length > 0 ? (
            <div className="form-field spawn-row">
              <label className="form-label" htmlFor="spawn-workspace">
                {t('tree.dialog.workspace')}
              </label>
              <select
                id="spawn-workspace"
                className="req-input"
                value={fields.workspaceId}
                onChange={(event) => set({ workspaceId: event.target.value })}
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
          <div className="form-field">
            <label className="form-label" htmlFor="spawn-cwd">
              {t('tree.dialog.cwd')}
            </label>
            <input
              id="spawn-cwd"
              className="req-input mono"
              value={fields.cwd}
              autoComplete="off"
              spellCheck={false}
              placeholder={parent.cwd}
              onChange={(event) => set({ cwd: event.target.value })}
            />
          </div>
          <div className="form-field spawn-row">
            <label className="form-label" htmlFor="spawn-sandbox">
              {t('tree.dialog.sandbox')}
            </label>
            <select
              id="spawn-sandbox"
              className="req-input"
              value={fields.sandbox}
              onChange={(event) => set({ sandbox: event.target.value as SpawnFields['sandbox'] })}
            >
              <option value="">{t('tree.dialog.sandboxParent')}</option>
              {SANDBOX_CHOICES.map((level) => (
                <option key={level} value={level}>
                  {t(SANDBOX_LEVEL[level])}
                </option>
              ))}
            </select>
          </div>
          <fieldset className="form-field spawn-kind">
            <legend className="form-label">{t('tree.dialog.kind')}</legend>
            <label>
              <input
                type="radio"
                name="spawn-kind"
                value="fresh"
                checked={shownKind === 'fresh'}
                onChange={() => set({ kind: 'fresh' })}
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
                onChange={() => set({ kind: 'fork' })}
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
              value={fields.title}
              autoComplete="off"
              placeholder={proposal ? undefined : t('tree.dialog.nameHint')}
              onChange={(event) => set({ title: event.target.value })}
            />
          </div>
          <div className="form-field">
            <label className="form-label" htmlFor="spawn-prompt">
              {t('tree.dialog.prompt')}
            </label>
            <textarea
              id="spawn-prompt"
              className="req-input spawn-prompt"
              value={fields.prompt}
              rows={proposal ? 6 : 4}
              autoFocus
              onChange={(event) => set({ prompt: event.target.value })}
            />
          </div>
          {shownKind === 'fresh' ? (
            <div className="form-field">
              <label className="form-label" htmlFor="spawn-background">
                {t('tree.dialog.background')}
              </label>
              <textarea
                id="spawn-background"
                className="req-input spawn-prompt"
                value={fields.background}
                rows={proposal && fields.background ? 4 : 2}
                placeholder={t('tree.dialog.backgroundHint')}
                onChange={(event) => set({ background: event.target.value })}
              />
            </div>
          ) : null}
          <label className="spawn-wake">
            <input
              type="checkbox"
              checked={fields.wake}
              onChange={(event) => set({ wake: event.target.checked })}
            />
            {t('tree.dialog.wake')}
          </label>
          <WorktreeCheck
            deviceId={deviceId}
            checked={fields.worktree}
            onChange={(worktree) => set({ worktree })}
          />
          {failure ? <div className="modal-note err">{failure}</div> : null}
        </div>
        <div className="modal-foot">
          <span className="grow" />
          <button type="button" className="btn" onClick={onClose}>
            {t('tree.dialog.cancel')}
          </button>
          <button type="submit" className="btn primary" disabled={!text || busy}>
            {proposal ? t('proposal.start') : t('tree.dialog.start')}
          </button>
        </div>
      </form>
    </dialog>
  )
}
