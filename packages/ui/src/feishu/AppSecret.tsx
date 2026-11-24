// 应用详情 · App Secret：只显示更新时间（秘密只进不出），“更换 App Secret”开一个对话框填新的。
// 带 expectedGeneration，设备上的凭据已被别处换过时拒绝；提交即从界面状态里清掉。
import { useEffect, useRef, useState } from 'react'
import { useT } from '../app/appearance.ts'
import { stamp } from '../app/format.ts'
import { Close } from '../app/icons.tsx'
import { useServices } from '../app/services.tsx'
import { operationId } from '../external/model.ts'
import { Field } from '../external/parts.tsx'
import { type OnApp, useFeishuRun } from './data.ts'
import type { FeishuApp } from './model.ts'

function RotateDialog({
  deviceId,
  app,
  onApp,
  onClose,
}: {
  deviceId: string
  app: FeishuApp
  onApp: OnApp
  onClose(): void
}) {
  const t = useT()
  const { channel } = useServices()
  const dialog = useRef<HTMLDialogElement>(null)
  const [secret, setSecret] = useState('')
  const act = useFeishuRun()
  useEffect(() => {
    const element = dialog.current
    if (element && !element.open) element.showModal()
  }, [])
  const save = async () => {
    const appSecret = secret
    setSecret('')
    const result = await act.run(() =>
      channel.command('feishu.app.rotate', {
        deviceId,
        appId: app.appId,
        operationId: operationId(),
        appSecret,
        expectedGeneration: app.credential.generation,
      }),
    )
    if (!result) return
    onApp(result.app)
    onClose()
  }
  return (
    <dialog
      ref={dialog}
      className="modal ext-dialog"
      aria-label={t('feishu.secret.rotate')}
      onClose={onClose}
      onKeyDown={(event) => {
        if (event.key === 'Escape') event.stopPropagation()
      }}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault()
          if (secret && !act.busy) void save()
        }}
      >
        <div className="modal-head">
          <span className="grow ell">{t('feishu.secret.rotate')}</span>
          <button
            type="button"
            className="ibtn"
            title={t('feishu.close')}
            aria-label={t('feishu.close')}
            onClick={onClose}
          >
            <Close />
          </button>
        </div>
        <div className="modal-body">
          <label className="fs-form-row">
            <span>{t('feishu.secret.new')}</span>
            <input
              className="req-input mono"
              type="password"
              value={secret}
              autoComplete="off"
              spellCheck={false}
              data-feishu-secret
              onChange={(event) => setSecret(event.target.value)}
            />
            <span className="fs-hint">{t('feishu.secret.rotateNote')}</span>
          </label>
          {act.error ? (
            <div className="modal-note err" role="alert">
              {act.error}
            </div>
          ) : null}
        </div>
        <div className="modal-foot">
          <span className="grow" />
          <button type="button" className="btn ghost" onClick={onClose}>
            {t('feishu.cancel')}
          </button>
          <button
            type="submit"
            className="btn primary"
            data-act="feishu-rotate-save"
            disabled={act.busy || !secret}
          >
            {t('feishu.secret.save')}
          </button>
        </div>
      </form>
    </dialog>
  )
}

export function AppSecret({
  deviceId,
  app,
  online,
  onApp,
}: {
  deviceId: string
  app: FeishuApp
  online: boolean
  onApp: OnApp
}) {
  const t = useT()
  const [rotating, setRotating] = useState(false)
  return (
    <section className="ext-block" data-feishu-secret-block>
      <Field label={t('feishu.secret.title')}>
        <span className="ext-row-meta">
          {t('feishu.secret.updated', {
            time: stamp(app.credential.updatedAt * 1000, Date.now(), t.lang),
          })}
        </span>
        <span className="grow" />
        <button
          type="button"
          className="btn ghost"
          data-act="feishu-rotate"
          disabled={!online}
          onClick={() => setRotating(true)}
        >
          {t('feishu.secret.rotate')}
        </button>
      </Field>
      {rotating && online ? (
        <RotateDialog
          deviceId={deviceId}
          app={app}
          onApp={onApp}
          onClose={() => setRotating(false)}
        />
      ) : null}
    </section>
  )
}
