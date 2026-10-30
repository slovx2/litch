// 设置页“通知”那一组：会话回合结束、要人处理时发不发系统通知（默认发）；定时任务跑完了发不发：
// 失败的一定发（只写一句，不给开关），成功的看开关，默认关。通知是这台电脑的桌面外壳发的，普通浏览器里只写一句说明。
import { useT } from '../app/appearance.ts'
import {
  setNotifyScope,
  setNotifySessions,
  useNotifyScope,
  useNotifySessions,
} from '../notify/session-notice.ts'
import { setNotifySuccess, useNotifySuccess } from '../tasks/notify-pref.ts'
import { Choice, Row } from './Look.tsx'

export function NotifySection() {
  const t = useT()
  const on = useNotifySuccess()
  const sessions = useNotifySessions()
  const scope = useNotifyScope()
  const desktop = window.litchShell?.notify !== undefined
  return (
    <>
      <section className="set-block" data-notify-sessions={sessions ? 'on' : 'off'}>
        <h3>{t('settings.notify.sessions')}</h3>
        {desktop ? null : <p className="set-para">{t('settings.notify.browser')}</p>}
        <div className="set-rows">
          <Row title={t('settings.notify.scope')} note={t('settings.notify.scope.note')}>
            <Choice
              name="notifyScope"
              value={scope}
              options={['all', 'main'] as const}
              label={(option) => t(`settings.notify.scope.${option}`)}
              onPick={setNotifyScope}
            />
          </Row>
          <div className="set-row">
            <div className="set-switch-text">
              <label htmlFor="set-notify-sessions">{t('settings.notify.sessionsSwitch')}</label>
            </div>
            <button
              id="set-notify-sessions"
              type="button"
              role="switch"
              className="switch"
              data-act="notify-sessions"
              aria-checked={sessions}
              onClick={() => setNotifySessions(!sessions)}
            >
              <i />
            </button>
          </div>
        </div>
      </section>
      <section className="set-block" data-notify-success={on ? 'on' : 'off'}>
        <h3>{t('settings.notify.tasks')}</h3>
        <div className="set-rows">
          <div className="set-row">
            <span className="set-note">{t('settings.notify.failures')}</span>
          </div>
          <div className="set-row">
            <div className="set-switch-text">
              <label htmlFor="set-notify-success">{t('settings.notify.success')}</label>
            </div>
            <button
              id="set-notify-success"
              type="button"
              role="switch"
              className="switch"
              data-act="notify-success"
              aria-checked={on}
              onClick={() => setNotifySuccess(!on)}
            >
              <i />
            </button>
          </div>
        </div>
      </section>
    </>
  )
}
