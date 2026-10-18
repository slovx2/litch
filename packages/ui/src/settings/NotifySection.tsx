// 设置页“通知”那一组：定时任务跑完了发不发系统通知。失败的一定发（只写一句，不给开关）；
// 成功的看这里的开关，默认关。通知是这台电脑的桌面外壳发的，普通浏览器里只写一句说明。
import { useT } from '../app/appearance.ts'
import { setNotifySuccess, useNotifySuccess } from '../tasks/notify-pref.ts'

export function NotifySection() {
  const t = useT()
  const on = useNotifySuccess()
  const desktop = window.litchShell?.notify !== undefined
  return (
    <section className="set-block" data-notify-success={on ? 'on' : 'off'}>
      <h3>{t('settings.notify.tasks')}</h3>
      {desktop ? null : <p className="set-para">{t('settings.notify.browser')}</p>}
      <div className="set-rows">
        <div className="set-row">
          <span className="set-note">{t('settings.notify.failures')}</span>
        </div>
        <div className="set-row">
          <div className="set-switch-text">
            <label htmlFor="set-notify-success">{t('settings.notify.success')}</label>
            <span className="set-note">{t('settings.notify.successNote')}</span>
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
  )
}
