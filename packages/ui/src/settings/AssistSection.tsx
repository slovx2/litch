// 设置页“配置助手”那一组：向本机 harness 安装产品手册的开关、手册装到了哪些地方（没装上的写原因）、
// “打开配置助手”“重新打开引导”。开关和状态来自外壳（window.litchManual，assist/manual-bridge.ts）；
// 没有外壳给的接口时不出开关和清单，两个按钮照样有。
import { useEffect, useState } from 'react'
import { requestAssistant } from '../app/actions.ts'
import { useT } from '../app/appearance.ts'
import { type ManualStatus, manualBridge } from '../assist/manual-bridge.ts'
import type { MessageKey } from '../i18n/index.ts'
import { reopenOnboarding } from '../onboarding/state.ts'

const STATE_KEY: Record<ManualStatus['targets'][number]['state'], MessageKey> = {
  installed: 'assist.manual.state.installed',
  linked: 'assist.manual.state.linked',
  skipped: 'assist.manual.state.skipped',
  failed: 'assist.manual.state.failed',
  removed: 'assist.manual.state.removed',
  foreign: 'assist.manual.state.foreign',
}

const STATE_CLASS: Record<ManualStatus['targets'][number]['state'], string> = {
  installed: 'pill ok',
  linked: 'pill ok',
  skipped: 'pill mute',
  failed: 'pill err',
  removed: 'pill mute',
  foreign: 'pill wait',
}

function ManualBlock() {
  const t = useT()
  const bridge = manualBridge()
  /** undefined：还在问（第一次最长要八秒上下）；null：问不到 */
  const [status, setStatus] = useState<ManualStatus | null | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!bridge) return
    let alive = true
    bridge.status().then(
      (next) => {
        if (alive) setStatus(next)
      },
      () => {
        if (alive) setStatus(null)
      },
    )
    return () => {
      alive = false
    }
  }, [bridge])
  if (!bridge) return null
  const toggle = async (on: boolean) => {
    setBusy(true)
    try {
      setStatus(await bridge.setEnabled(on))
    } catch {
      setStatus(null)
    } finally {
      setBusy(false)
    }
  }
  const on = status?.enabled ?? true
  return (
    <section
      className="set-block"
      data-manual={status ? (status.enabled ? 'on' : 'off') : 'loading'}
    >
      <h3>{t('assist.manual.title')}</h3>
      <div className="set-rows">
        <div className="set-row">
          <div className="set-switch-text">
            <label htmlFor="set-manual">{t('assist.manual.switch')}</label>
            <span className="set-note">{t('assist.manual.note')}</span>
          </div>
          <button
            id="set-manual"
            type="button"
            role="switch"
            className="switch"
            data-act="manual-switch"
            aria-checked={on}
            disabled={busy || status === undefined}
            onClick={() => void toggle(!on)}
          >
            <i />
          </button>
        </div>
        {status === undefined ? (
          <div className="set-row">
            <span className="set-note">{t('assist.manual.loading')}</span>
          </div>
        ) : status === null ? (
          <div className="set-row">
            <span className="set-note">{t('assist.manual.unknown')}</span>
          </div>
        ) : (
          <>
            {status.dir ? (
              <div className="set-row">
                <span className="set-note">{t('assist.manual.dir')}</span>
                <code className="mono" data-manual-dir>
                  {status.dir}
                </code>
              </div>
            ) : null}
            {status.error ? (
              <div className="set-row" data-manual-error>
                <span className="set-note">
                  {t('assist.manual.error', { reason: status.error })}
                </span>
              </div>
            ) : null}
            {status.targets.length > 0 ? (
              <ul className="assist-targets">
                {status.targets.map((target) => (
                  <li key={`${target.harness}:${target.path}`} data-target={target.harness}>
                    <b>{target.harness}</b>
                    <span className={STATE_CLASS[target.state]}>{t(STATE_KEY[target.state])}</span>
                    <code className="mono dim">{target.path}</code>
                    {target.reason ? <span className="dim">{target.reason}</span> : null}
                  </li>
                ))}
              </ul>
            ) : null}
          </>
        )}
      </div>
    </section>
  )
}

export function AssistSection() {
  const t = useT()
  return (
    <>
      <section className="set-block">
        <h3>{t('assist.section.open')}</h3>
        <div className="set-rows">
          <div className="set-row">
            <span className="set-note">{t('assist.section.openNote')}</span>
            <button
              type="button"
              className="btn"
              data-act="open-assistant"
              onClick={requestAssistant}
            >
              {t('assist.section.openButton')}
            </button>
          </div>
          <div className="set-row">
            <span className="set-note">{t('assist.section.onboardNote')}</span>
            <button
              type="button"
              className="btn"
              data-act="reopen-onboarding"
              onClick={reopenOnboarding}
            >
              {t('assist.section.onboardButton')}
            </button>
          </div>
        </div>
      </section>
      <ManualBlock />
    </>
  )
}
