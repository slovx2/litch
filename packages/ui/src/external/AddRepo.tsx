// 添加仓库（对话框）：从已授权身份能访问的仓库里选一个，填设备上的工作目录、选采集身份，
// 先看近 24 小时预览再添加。触发、门槛、反馈、回写等用默认值，添加后在仓库行里展开修改；自动提醒默认关。
import type { ExternalIdentityRepository } from '@litch/core'
import { useEffect, useRef, useState } from 'react'
import { useT } from '../app/appearance.ts'
import { Close } from '../app/icons.tsx'
import { useServices } from '../app/services.tsx'
import { useRun } from './data.ts'
import { type IdentityHead, newSourceDraft, operationId, repoLabel, sourceIdOf } from './model.ts'
import { PreviewResult, type PreviewValue } from './Preview.tsx'

export function AddRepo({
  deviceId,
  repositories,
  identities,
  taken,
  onClose,
}: {
  deviceId: string
  repositories: ExternalIdentityRepository[]
  identities: IdentityHead[]
  taken: ReadonlySet<string>
  onClose(): void
}) {
  const t = useT()
  const { channel } = useServices()
  const dialog = useRef<HTMLDialogElement>(null)
  const [picked, setPicked] = useState<string | null>(null)
  const [root, setRoot] = useState('')
  const [poll, setPoll] = useState('')
  const [filter, setFilter] = useState('')
  const [preview, setPreview] = useState<PreviewValue | null>(null)
  const act = useRun()
  useEffect(() => {
    const element = dialog.current
    if (element && !element.open) element.showModal()
  }, [])
  const choices = repositories.filter(
    (one) =>
      !taken.has(one.repoId) &&
      one.grants.some((g) => g.read) &&
      repoLabel(one).toLowerCase().includes(filter.trim().toLowerCase()),
  )
  const repo = repositories.find((one) => one.repoId === picked) ?? null
  const draft = repo
    ? newSourceDraft(repo, {
        sourceId: sourceIdOf(repo.repoId),
        localRoot: root.trim(),
        pollIdentity: poll || null,
      })
    : null
  const loginOf = (identityId: string) =>
    identities.find((one) => one.identityId === identityId)?.login ?? identityId

  const runPreview = async () => {
    if (!draft) return
    const result = await act.run(() =>
      channel.command('external.source.preview', { deviceId, source: draft }),
    )
    if (result) setPreview(result)
  }
  const add = async () => {
    if (!draft) return
    const result = await act.run(() =>
      channel.command('external.source.upsert', {
        deviceId,
        source: draft,
        expectedRevision: 0,
        operationId: operationId(),
      }),
    )
    if (result) onClose()
  }

  return (
    <dialog
      ref={dialog}
      className="modal ext-dialog"
      aria-label={t('ext.repo.add')}
      onClose={onClose}
      onKeyDown={(event) => {
        if (event.key === 'Escape') event.stopPropagation()
      }}
    >
      <form onSubmit={(event) => event.preventDefault()}>
        <div className="modal-head">
          <span className="grow ell">{t('ext.repo.add')}</span>
          <button
            type="button"
            className="ibtn"
            title={t('ext.close')}
            aria-label={t('ext.close')}
            onClick={onClose}
          >
            <Close />
          </button>
        </div>
        <div className="modal-body">
          {repositories.length > 6 ? (
            <input
              className="req-input"
              value={filter}
              placeholder={t('ext.repo.filter')}
              aria-label={t('ext.repo.filter')}
              onChange={(event) => setFilter(event.target.value)}
            />
          ) : null}
          {choices.length ? (
            <ul className="ext-pick" aria-label={t('ext.repos')}>
              {choices.map((one) => (
                <li key={one.repoId} data-repo={one.repoId}>
                  <button
                    type="button"
                    aria-pressed={picked === one.repoId}
                    className="ext-pick-row"
                    onClick={() => {
                      setPicked(one.repoId)
                      setPreview(null)
                    }}
                  >
                    <b className="ell">{repoLabel(one)}</b>
                    <span className="grow" />
                    {one.grants.map((g) => (
                      <span
                        key={g.identityId}
                        className={g.write === 'verified' ? 'pill ok' : 'pill mute'}
                        title={t(`ext.grant.${g.write}`)}
                      >
                        {loginOf(g.identityId)}
                      </span>
                    ))}
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <div className="ext-empty">{t('ext.repo.noChoice')}</div>
          )}
          {repo ? (
            <div className="ext-detail">
              <label className="ext-field">
                <span className="ext-field-label">{t('ext.repo.root')}</span>
                <input
                  className="req-input mono ext-input"
                  value={root}
                  spellCheck={false}
                  placeholder={t('ext.repo.rootHint')}
                  onChange={(event) => {
                    setRoot(event.target.value)
                    setPreview(null)
                  }}
                />
              </label>
              <label className="ext-field">
                <span className="ext-field-label">{t('ext.repo.poll')}</span>
                <select
                  className="ext-select modal-select"
                  value={poll}
                  onChange={(event) => {
                    setPoll(event.target.value)
                    setPreview(null)
                  }}
                >
                  <option value="">{t('ext.repo.pollAuto')}</option>
                  {repo.grants
                    .filter((g) => g.read)
                    .map((g) => (
                      <option key={g.identityId} value={g.identityId}>
                        {loginOf(g.identityId)}
                      </option>
                    ))}
                </select>
              </label>
            </div>
          ) : null}
          {preview ? <PreviewResult value={preview} /> : null}
          {act.error ? (
            <div className="modal-note err" role="alert">
              {act.error}
            </div>
          ) : null}
        </div>
        <div className="modal-foot">
          <span className="grow" />
          <button
            type="button"
            className="btn"
            data-act="repo-preview"
            disabled={!draft || !root.trim() || act.busy}
            onClick={() => void runPreview()}
          >
            {t('ext.preview')}
          </button>
          <button
            type="button"
            className="btn primary"
            data-act="repo-save"
            disabled={!draft || !root.trim() || act.busy}
            onClick={() => void add()}
          >
            {t('ext.repo.addYes')}
          </button>
        </div>
      </form>
    </dialog>
  )
}
