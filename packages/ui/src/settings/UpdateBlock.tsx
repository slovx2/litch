// 应用自己的更新在界面上的两处：设置的“关于”里的一块（状态、检查更新、自动检查的开关、重启以更新），
// 以及下好之后浮出来的一条提示。接口是桌面外壳给的（update-bridge.ts），浏览器里两处都没有。
import type { UpdateState } from '@litch/core'
import { useEffect, useState } from 'react'
import { useT } from '../app/appearance.ts'
import { showToast } from '../app/toasts.tsx'
import type { Translator } from '../i18n/index.ts'
import { type UpdateBridge, type UpdateView, updateBridge } from './update-bridge.ts'

function stateText(state: UpdateState, t: Translator): string {
  switch (state.phase) {
    case 'idle':
      return t('settings.update.idle')
    case 'checking':
      return t('settings.update.checking')
    case 'latest':
      return t('settings.update.latest')
    // 桌面查到了就自己下，“有新版本还没下”只是一瞬间，和“正在下”说成一样
    case 'available':
      return t('settings.update.downloading', { version: state.version })
    case 'downloading':
      return state.progress === undefined
        ? t('settings.update.downloading', { version: state.version })
        : t('settings.update.downloadingPct', {
            version: state.version,
            pct: Math.round(state.progress * 100),
          })
    case 'ready':
      return t('settings.update.ready', { version: state.version })
    case 'failed':
      return t('settings.update.failed')
  }
}

const install = (bridge: UpdateBridge) => {
  void bridge.install().catch(() => {})
}

/** 设置的“关于”里那一块。外壳没给接口、或者这台机器不出更新，就不显示 */
export function UpdateBlock() {
  const t = useT()
  const bridge = updateBridge()
  const [view, setView] = useState<UpdateView | null>(null)

  useEffect(() => {
    if (!bridge) return
    let dropped = false
    bridge.get().then(
      (got) => {
        if (!dropped) setView(got)
      },
      () => {},
    )
    const off = bridge.onState((state) => setView((now) => (now ? { ...now, state } : now)))
    return () => {
      dropped = true
      off()
    }
  }, [bridge])

  if (!bridge || !view?.supported) return null
  const { state, auto } = view
  const busy =
    state.phase === 'checking' || state.phase === 'downloading' || state.phase === 'available'
  return (
    <section className="set-block" data-update={state.phase}>
      <h3>{t('settings.update')}</h3>
      <div className="set-rows">
        <div className="set-row">
          <div className="set-switch-text">
            <span className="update-text" data-update-text>
              {stateText(state, t)}
            </span>
            {state.phase === 'failed' ? <span className="set-note">{state.message}</span> : null}
          </div>
          {state.phase === 'ready' ? (
            <button
              type="button"
              className="mini"
              data-act="update-install"
              onClick={() => install(bridge)}
            >
              {t('settings.update.install')}
            </button>
          ) : (
            <button
              type="button"
              className="mini"
              data-act="update-check"
              disabled={busy}
              onClick={() => {
                void bridge.check().then(
                  (got) => got && setView(got),
                  () => {},
                )
              }}
            >
              {t('settings.update.check')}
            </button>
          )}
        </div>
        <div className="set-row">
          <div className="set-switch-text">
            <label htmlFor="set-auto-update">{t('settings.update.auto')}</label>
            <span className="set-note">{t('settings.update.auto.note')}</span>
          </div>
          <button
            id="set-auto-update"
            type="button"
            role="switch"
            className="switch"
            data-act="auto-update"
            aria-checked={auto}
            onClick={() => {
              void bridge.setAuto(!auto).then(
                (got) => got && setView(got),
                () => {},
              )
            }}
          >
            <i />
          </button>
        </div>
      </div>
    </section>
  )
}

/** 下好了就浮一条提示，一直留着，直到点了“重启以更新”或者关掉。同一版只提示一次 */
export function useUpdateToast(): void {
  useEffect(() => {
    const bridge = updateBridge()
    if (!bridge) return
    let told: string | null = null
    const tell = (state: UpdateState) => {
      if (state.phase !== 'ready' || told === state.version) return
      told = state.version
      const version = state.version
      showToast({
        id: 'update-ready',
        lifeMs: 0,
        text: (t) => t('settings.update.toast', { version }),
        action: { label: (t) => t('settings.update.install'), run: () => install(bridge) },
      })
    }
    bridge.get().then(
      (view) => view && tell(view.state),
      () => {},
    )
    return bridge.onState(tell)
  }, [])
}
