// 设置页“Computer Use”那一组（只在 macOS、Windows 上的桌面外壳里有，见 computer-bridge.ts）。
// macOS：两项系统权限（辅助功能、屏幕录制）给没给，没给的说明一句、给一个“打开系统设置”让用户自己去打开；
// 屏幕录制授权之后要重启助手才生效，所以没给的时候还有“重启助手”；最后一句说明每台设备的开关在设备详情里。
// 没有按应用的授权：所有应用都能操作。
//
// 查权限会拉起助手，只在这一组打开时查（不在启动时、也不在设备详情里为看一眼去拉起）。用户从系统设置切回来时
// 窗口重新拿到焦点，再问一次在跑的助手（不拉起）。应用从不替用户改系统设置，也不调会弹系统授权框的接口。
// Windows：没有系统权限这一块，换成助手的状态（在不在跑、版本、上次的错）和两条提醒（Litch 以管理员身份运行、
// UAC 关着）。设备开关的说明两个平台一样。
import { useCallback, useEffect, useRef, useState } from 'react'
import { useT } from '../app/appearance.ts'
import { reasonOf } from '../app/errors.ts'
import type { MessageKey } from '../i18n/index.ts'
import {
  type ComputerUseBridge,
  type ComputerUseState,
  computerBridge,
  type PermissionPane,
} from './computer-bridge.ts'
import {
  allGranted,
  helperLook,
  offersRestart,
  PANES,
  type PermissionLook,
  permissionLook,
  winWarnings,
} from './tools-logic.ts'

const PANE_TITLES: Record<PermissionPane, MessageKey> = {
  accessibility: 'settings.computer.accessibility',
  screenRecording: 'settings.computer.screenRecording',
}
const PANE_NOTES: Record<PermissionPane, MessageKey> = {
  accessibility: 'settings.computer.accessibility.note',
  screenRecording: 'settings.computer.screenRecording.note',
}
const LOOKS: Record<PermissionLook, MessageKey> = {
  granted: 'settings.computer.granted',
  missing: 'settings.computer.missing',
  unknown: 'settings.computer.unknown',
}

export function ComputerSection({ onDevices }: { onDevices(): void }) {
  const t = useT()
  const bridge = computerBridge()
  // 设置页不给没有这个接口的窗口列出这一组；万一直接要到了，什么都不画
  if (!bridge) return null
  return (
    <>
      {bridge.platform === 'win32' ? (
        <HelperStatus bridge={bridge} />
      ) : (
        <Permissions bridge={bridge} />
      )}
      <section className="set-block">
        <div className="set-rows">
          <div className="set-row">
            <span className="set-note">{t('settings.computer.devices')}</span>
            <button type="button" className="btn" data-act="open-devices" onClick={onDevices}>
              {t('settings.devices.open')}
            </button>
          </div>
        </div>
      </section>
    </>
  )
}

function Permissions({ bridge }: { bridge: ComputerUseBridge }) {
  const t = useT()
  /** null：还没问到 */
  const [state, setState] = useState<ComputerUseState | null>(null)
  const [checking, setChecking] = useState(true)
  /** 没打开的那一页（系统设置没打开） */
  const [unopened, setUnopened] = useState<PermissionPane | null>(null)
  /** 现在的状态，给拿回焦点时用：助手起不来的时候不去把出错的说法换成“不知道” */
  const now = useRef(state)
  now.current = state

  const ask = useCallback(
    (asking: Promise<ComputerUseState | null>) => {
      setChecking(true)
      asking
        .then(
          (next) => {
            if (next) setState(next)
          },
          (error: unknown) =>
            setState({
              platform: 'darwin',
              helper: 'failed',
              permissions: null,
              reason: reasonOf(error, t),
            }),
        )
        .finally(() => setChecking(false))
    },
    [t],
  )

  // 打开这一组时问一次（会拉起助手）；从系统设置切回来（窗口拿回焦点）时再问在跑的那个
  useEffect(() => {
    ask(bridge.status(true))
    const again = () => {
      if (now.current?.helper === 'ready') ask(bridge.status(false))
    }
    window.addEventListener('focus', again)
    return () => window.removeEventListener('focus', again)
  }, [bridge, ask])

  const open = (pane: PermissionPane) => {
    setUnopened(null)
    bridge.openSettings(pane).then(
      (opened) => {
        if (!opened) setUnopened(pane)
      },
      () => setUnopened(pane),
    )
  }

  const failed = state?.helper === 'failed'
  return (
    <section
      className="set-block"
      data-perms={state ? state.helper : 'loading'}
      data-checking={checking}
    >
      <h3>
        {t('settings.computer.permissions')}
        <span>{t('settings.computer.permissions.note')}</span>
      </h3>
      <p className="set-para">{t('automation.capture.notice')}</p>
      {state?.permissions?.captureStatus === 'ready' && (
        <p className="set-note">{t('automation.capture.ready')}</p>
      )}
      {state?.permissions?.captureStatus === 'pending' && (
        <p className="set-note">{t('automation.capture.pending')}</p>
      )}
      {state?.permissions?.captureStatus === 'denied' && (
        <p className="set-note">{t('automation.capture.denied')}</p>
      )}
      {state === null ? (
        <p className="set-para">{t('settings.computer.checking')}</p>
      ) : (
        <div className="set-rows">
          {PANES.map((pane) => {
            const look = permissionLook(state, pane)
            return (
              <div key={pane} className="set-row perm-row" data-pane={pane} data-perm={look}>
                <span className="set-label">{t(PANE_TITLES[pane])}</span>
                <span className="perm-state" data-perm={look}>
                  {t(LOOKS[look])}
                </span>
                <span className="set-note">{t(PANE_NOTES[pane])}</span>
                {look === 'missing' ? (
                  <button
                    type="button"
                    className="mini"
                    data-act="open-pane"
                    onClick={() => open(pane)}
                  >
                    {t('settings.computer.open')}
                  </button>
                ) : null}
              </div>
            )
          })}
          {offersRestart(state) ? (
            <div className="set-row" data-row="restart">
              <span className="set-note">{t('settings.computer.restart.note')}</span>
              <button
                type="button"
                className="btn"
                data-act="restart-helper"
                disabled={checking}
                onClick={() => ask(bridge.restart())}
              >
                {t('settings.computer.restart')}
              </button>
            </div>
          ) : null}
        </div>
      )}
      <div className="set-actions">
        {failed ? (
          <span className="set-note err" role="alert">
            {t('settings.computer.failed', { reason: state?.reason ?? '' })}
          </span>
        ) : unopened ? (
          <span className="set-note err" role="alert">
            {t('settings.computer.openFailed', { pane: t(PANE_TITLES[unopened]) })}
          </span>
        ) : allGranted(state) ? (
          <span className="set-note">{t('settings.computer.ready')}</span>
        ) : null}
        <button
          type="button"
          className="btn ghost"
          data-act="recheck"
          disabled={checking}
          onClick={() => ask(bridge.status(true))}
        >
          {checking && state !== null
            ? t('settings.computer.checking')
            : t('settings.computer.recheck')}
        </button>
      </div>
    </section>
  )
}

/** Windows：助手的状态和提醒。打开这一组时问一次（会拉起助手），之后只在用户点的时候问 */
function HelperStatus({ bridge }: { bridge: ComputerUseBridge }) {
  const t = useT()
  const [state, setState] = useState<ComputerUseState | null>(null)
  const [checking, setChecking] = useState(true)

  const ask = useCallback(
    (asking: Promise<ComputerUseState | null>) => {
      setChecking(true)
      asking
        .then(
          (next) => {
            if (next) setState(next)
          },
          (error: unknown) =>
            setState({
              platform: 'win32',
              helper: 'failed',
              permissions: null,
              reason: reasonOf(error, t),
            }),
        )
        .finally(() => setChecking(false))
    },
    [t],
  )
  useEffect(() => {
    ask(bridge.status(true))
  }, [bridge, ask])

  const look = helperLook(state)
  const info = state?.windows ?? null
  const warnings = winWarnings(state)
  return (
    <section className="set-block" data-helper={look} data-checking={checking}>
      <h3>{t('settings.computer.helper')}</h3>
      {state === null ? (
        <p className="set-para">{t('settings.computer.checking')}</p>
      ) : (
        <div className="set-rows">
          <div className="set-row" data-row="helper">
            <span className="set-label">{t('settings.computer.helper.state')}</span>
            <span className="perm-state" data-perm={look === 'running' ? 'granted' : 'unknown'}>
              {look === 'running'
                ? t('settings.computer.helper.running')
                : look === 'failed'
                  ? t('settings.computer.helper.failed')
                  : t('settings.computer.helper.idle')}
            </span>
            <span className="set-note">
              {info
                ? t('settings.computer.helper.version', {
                    version: info.version ?? '?',
                    pid: String(info.pid),
                  })
                : t('settings.computer.helper.lazy')}
            </span>
          </div>
          {warnings.map((warning) => (
            <div key={warning} className="set-row" data-warn={warning}>
              <span className="set-note err" role="alert">
                {t(
                  warning === 'admin'
                    ? 'settings.computer.helper.admin'
                    : 'settings.computer.helper.uac',
                )}
              </span>
            </div>
          ))}
        </div>
      )}
      <div className="set-actions">
        {state?.reason ? (
          <span className="set-note err" role="alert">
            {t('settings.computer.failed', { reason: state.reason })}
          </span>
        ) : null}
        <button
          type="button"
          className="btn ghost"
          data-act="restart-helper"
          disabled={checking}
          onClick={() => ask(bridge.restart())}
        >
          {t('settings.computer.restart')}
        </button>
        <button
          type="button"
          className="btn ghost"
          data-act="recheck"
          disabled={checking}
          onClick={() => ask(bridge.status(true))}
        >
          {checking && state !== null
            ? t('settings.computer.checking')
            : t('settings.computer.recheck')}
        </button>
      </div>
    </section>
  )
}
