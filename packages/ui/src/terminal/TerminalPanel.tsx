// 对话区下面的终端面板。终端挂在工作区上：同一个工作区的会话共用一组，不属于任何工作区的会话用设备主目录的那一组。
// 面板一直在页面里，收起只是不显示：里面的终端（sessions.ts）不拆，所以再打开、换会话再回来，内容和滚到哪了都在。
import {
  type CoreChannel,
  type DeviceView,
  keys,
  LOOSE,
  type TerminalGroups,
  type TerminalInfo,
} from '@litch/core'
import {
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useAppearance, useT } from '../app/appearance.ts'
import { wireStyle } from '../app/device.ts'
import { whyNot } from '../app/errors.ts'
import { useKey, useServices } from '../app/services.tsx'
import { dismissToast, showToast } from '../app/toasts.tsx'
import type { MessageKey } from '../i18n/index.ts'
import {
  clampHeight,
  groupKey,
  PANEL_MIN,
  panelNow,
  pickTab,
  setPanelHeight,
  setPanelOpen,
  usePanel,
  usePickedTab,
} from './panel.ts'
import { createTerminalSessions, type TerminalSessions } from './sessions.ts'
import { type TabActions, TerminalTabs, terminalName } from './TerminalTabs.tsx'

/** 终端开在哪：哪台设备上的哪个工作区。workspaceId 为 null 是设备主目录的那一组 */
export interface TerminalPlace {
  deviceId: string
  workspaceId: string | null
}

const NONE: string[] = []
const made = new WeakMap<CoreChannel, TerminalSessions>()

/** 界面这一头开着的终端。整个应用只有一份，跟着通道走 */
export function useTerminalSessions(): TerminalSessions {
  const { channel, replica } = useServices()
  let sessions = made.get(channel)
  if (!sessions) {
    sessions = createTerminalSessions({ channel, replica })
    made.set(channel, sessions)
  }
  return sessions
}

/** 终端没在跑的时候盖在它下边的一条：是怎么回事，能不能重开 */
function StatusStrip({
  info,
  online,
  restarting,
  onRestart,
}: {
  info: TerminalInfo
  online: boolean
  /** 人刚点了重开、还没发出去：先按“正在启动”画（不占地方），终端好按腾出来的高度量大小 */
  restarting: boolean
  onRestart(): void
}) {
  const t = useT()
  if (info.state === 'running') return null
  const state = restarting ? 'starting' : info.state
  const text =
    state === 'starting'
      ? t('terminal.state.starting')
      : state === 'away'
        ? t('terminal.state.away')
        : state === 'exited'
          ? info.exitCode === null
            ? t('terminal.state.exitedNoCode')
            : t('terminal.state.exited', { code: info.exitCode })
          : t(info.durable ? 'terminal.state.lostDurable' : 'terminal.state.lostEphemeral')
  const over = state === 'exited' || state === 'lost'
  return (
    <div className="term-status" role="status" data-state={state}>
      <span>{text}</span>
      {over ? (
        <button
          type="button"
          className="btn"
          data-tool="restart"
          disabled={!online}
          onClick={onRestart}
        >
          {t('terminal.restart')}
        </button>
      ) : null}
    </div>
  )
}

export function TerminalPanel({
  place,
  startedOpen,
}: {
  place: TerminalPlace | null
  /** 应用启动时面板就开着：那不是人刚打开的，不抢焦点、不顺手新开 */
  startedOpen: boolean
}) {
  const { channel, replica } = useServices()
  const sessions = useTerminalSessions()
  const panel = usePanel()
  const appearance = useAppearance()
  const t = useT()
  const deviceId = place?.deviceId ?? ''
  const group = place ? (place.workspaceId ?? LOOSE) : ''
  const gkey = groupKey(deviceId, group)
  const device = useKey<DeviceView>(keys.device(deviceId))
  const groups = useKey<TerminalGroups>(keys.terminalGroups(deviceId))
  // 留在设备上的那些里，属于这一组的
  const stowed = useKey<TerminalGroups>(keys.terminalStowed(deviceId))?.[group] ?? NONE
  const durable = useKey<boolean | null>(keys.terminalsDurable(deviceId)) ?? null
  const ids = groups?.[group] ?? NONE
  const picked = usePickedTab(gkey)
  const activeId = picked && ids.includes(picked) ? picked : (ids.at(-1) ?? null)
  const active = useKey<TerminalInfo>(keys.terminal(deviceId, activeId ?? ''))
  const online = device?.connection === 'online'
  const visible = panel.open && place !== null
  const root = useRef<HTMLElement>(null)
  const mount = useRef<HTMLDivElement>(null)
  /** 这一步是人做的（打开面板、点标签、新开）：做完把焦点放进终端 */
  const wantFocus = useRef(false)
  /** 人点了重开、命令还没回来的那个终端。见下面的 restart */
  const [restarting, setRestarting] = useState<string | null>(null)
  const opening = useRef(false)

  const fail = useCallback((key: MessageKey, error: unknown) => {
    showToast({
      id: 'terminal-failed',
      tone: 'err',
      lifeMs: 8000,
      text: (say) => say(key, { reason: whyNot(error, say) }),
    })
  }, [])

  const create = useCallback(() => {
    if (!place || opening.current) return
    opening.current = true
    const { rows, cols } = sessions.sizeHint()
    channel
      .command('terminal.open', { deviceId, workspaceId: place.workspaceId, rows, cols })
      .then(
        ({ terminalId }) => {
          wantFocus.current = true
          pickTab(gkey, terminalId)
        },
        (error: unknown) => fail('terminal.failed.open', error),
      )
      .finally(() => {
        opening.current = false
      })
  }, [channel, sessions, place, deviceId, gkey, fail])

  // 终端都挂在同一个台子上，台子接在这里
  useLayoutEffect(() => {
    const host = mount.current
    if (!host) return
    host.appendChild(sessions.stage)
    const observer = new ResizeObserver(() => sessions.refit())
    observer.observe(host)
    return () => {
      observer.disconnect()
      sessions.stage.remove()
    }
  }, [sessions])

  // 谁在台上
  useLayoutEffect(() => {
    sessions.show(deviceId, visible ? activeId : null)
    if (visible && activeId && wantFocus.current) {
      wantFocus.current = false
      sessions.focus()
    }
  }, [sessions, deviceId, activeId, visible])

  // 皮肤、明暗换了，或者系统的明暗换了：配色和字体重读
  // biome-ignore lint/correctness/useExhaustiveDependencies: 外观换了就要重读，值本身用不着
  useEffect(() => {
    sessions.restyle()
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = () => sessions.restyle()
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [sessions, appearance.skin, appearance.theme])

  // 面板是人打开的：焦点进终端；这一组里一个都没有的话顺手开一个
  const wasOpen = useRef(startedOpen)
  useEffect(() => {
    const opened = panel.open && !wasOpen.current
    wasOpen.current = panel.open
    if (!opened || !place) return
    wantFocus.current = true
    if (groups && ids.length === 0 && online) create()
    else sessions.focus()
  }, [panel.open, place, groups, ids.length, online, create, sessions])

  const actions: TabActions = useMemo(
    () => ({
      pick(terminalId) {
        wantFocus.current = true
        pickTab(gkey, terminalId)
        sessions.focus()
      },
      rename(terminalId, title) {
        channel.command('terminal.rename', { deviceId, terminalId, title }).catch(() => {})
      },
      close(terminalId, mode) {
        channel.command('terminal.close', { deviceId, terminalId, mode }).then(
          () => {
            if (mode !== 'leave') return
            // 留在设备上了：说一声去哪了，顺手能接回来
            showToast({
              id: `terminal-left:${terminalId}`,
              lifeMs: 6000,
              text: (say) =>
                say('terminal.left', {
                  name: terminalName(
                    replica.store.get<TerminalInfo>(keys.terminal(deviceId, terminalId)),
                    say,
                  ),
                }),
              action: {
                label: (say) => say('terminal.stowed.attach'),
                run() {
                  dismissToast(`terminal-left:${terminalId}`)
                  actions.show(terminalId)
                },
              },
            })
          },
          (error: unknown) => fail('terminal.failed.close', error),
        )
      },
      show(terminalId) {
        channel.command('terminal.show', { deviceId, terminalId }).then(
          () => {
            wantFocus.current = true
            pickTab(gkey, terminalId)
          },
          (error: unknown) => fail('terminal.failed.show', error),
        )
      },
      create,
      clear() {
        sessions.current()?.clear()
        sessions.focus()
      },
      hide: () => setPanelOpen(false),
    }),
    [channel, replica, sessions, deviceId, gkey, create, fail],
  )

  // 重开分两步。已退出、已断开的状态条是占地方的，重开之后它没了，终端会高出两行：
  // 要是按点下去那一刻的大小起 shell，它刚起来就得再改一次大小，对面的 shell 收到“窗口变了”——
  // bash 在回车前后收到它，会把提示符在下一行重画一遍，头一条命令的输出就接在重画的提示符后面。
  // 所以先让状态条不占地方（restarting），等这一次排版完了，按腾出来的高度量好，再用那个大小重开
  const restart = () => {
    if (activeId) setRestarting(activeId)
  }
  useLayoutEffect(() => {
    if (!restarting) return
    sessions.refit()
    const { rows, cols } = sessions.sizeHint()
    wantFocus.current = true
    channel
      .command('terminal.restart', { deviceId, terminalId: restarting, rows, cols })
      .then(
        () => sessions.focus(),
        (error: unknown) => fail('terminal.failed.restart', error),
      )
      .finally(() => setRestarting((now) => (now === restarting ? null : now)))
  }, [restarting, channel, sessions, deviceId, fail])

  // 拖顶边调高度。高度只在拖的时候和松手时各记一次，终端跟着台子的大小自己重排
  const drag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const grip = event.currentTarget
    const room = root.current?.parentElement?.clientHeight ?? window.innerHeight
    const startY = event.clientY
    const startHeight = root.current?.offsetHeight ?? panel.height
    grip.setPointerCapture(event.pointerId)
    const move = (moved: PointerEvent) =>
      setPanelHeight(clampHeight(startHeight + (startY - moved.clientY), room))
    const stop = () => {
      grip.removeEventListener('pointermove', move)
      grip.removeEventListener('pointerup', stop)
      grip.removeEventListener('pointercancel', stop)
    }
    grip.addEventListener('pointermove', move)
    grip.addEventListener('pointerup', stop)
    grip.addEventListener('pointercancel', stop)
    event.preventDefault()
  }

  return (
    <section
      ref={root}
      className="term-dock"
      hidden={!visible}
      aria-label={t('terminal.panel')}
      style={{ ...wireStyle(device?.wire), height: panel.height }}
      data-device={deviceId}
      data-group={group}
    >
      {/* biome-ignore lint/a11y/useSemanticElements: 这是一条能拖、也能用方向键挪的分隔条，hr 做不了 */}
      <div
        className="term-grip"
        role="separator"
        aria-orientation="horizontal"
        aria-label={t('terminal.resize')}
        aria-valuenow={panel.height}
        aria-valuemin={PANEL_MIN}
        tabIndex={0}
        onPointerDown={drag}
        onKeyDown={(event) => {
          const step = { ArrowUp: 24, ArrowDown: -24 }[event.key]
          if (!step) return
          event.preventDefault()
          const room = root.current?.parentElement?.clientHeight ?? window.innerHeight
          // 用现在的高度：连着按得快的时候，画的那一刻记下的高度可能已经旧了
          setPanelHeight(clampHeight(panelNow().height + step, room))
        }}
      />
      <TerminalTabs
        deviceId={deviceId}
        ids={ids}
        activeId={activeId}
        stowed={stowed}
        durable={durable}
        canCreate={online}
        actions={actions}
      />
      <div className="term-body">
        <div className="term-mount" ref={mount} hidden={activeId === null} />
        {activeId === null ? (
          <div className="term-empty">
            <span>{t(online ? 'terminal.empty' : 'terminal.offline')}</span>
            {online ? (
              <button type="button" className="btn" data-tool="new" onClick={create}>
                {t('terminal.new')}
              </button>
            ) : null}
          </div>
        ) : active ? (
          <StatusStrip
            info={active}
            online={online}
            restarting={restarting === active.id}
            onRestart={restart}
          />
        ) : null}
      </div>
    </section>
  )
}
