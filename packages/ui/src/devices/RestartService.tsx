// 重启设备服务：侧栏设备行“⋯”里那一项点了之后的事。
// 先问核心现在会打断哪些会话：有就列出来再确认，确认了不等空闲直接重启（force）；没有就空闲时停（start），
// 服务说不闲（设备上的终端、这边看不到的回合）时再列出原因问一次。进度在设备行上写“重启中”，结果出一条提示。
// 状态机在核心（device/service-restart.mts），这里只发命令、画两个确认框、提示结果。
import {
  type DeviceView,
  keys,
  type ServiceRestartPhase,
  type ServiceRestartSession,
} from '@litch/core'
import { type ReactNode, useEffect, useState } from 'react'
import { useT } from '../app/appearance.ts'
import { Confirm } from '../app/Confirm.tsx'
import { nameOf } from '../app/device.ts'
import { useKey, useServices } from '../app/services.tsx'
import { showToast, type Toast } from '../app/toasts.tsx'
import type { Translator } from '../i18n/index.ts'
import { busyLine, restartFailureKey } from './service.ts'

/** 确认框里最多列几个会话，多的说“另有几个” */
const LISTED = 8

/** 已经提示过的结果（设备 + 那一刻）：侧栏重画、单独查看一组时组件换了一份，不再提示一次 */
const told = new Set<string>()

type Mode = 'start' | 'force' | 'dismiss'

export interface RestartFlow {
  /** 菜单上点了“重启设备服务” */
  begin(): void
  /** 两个确认框，放在设备那一组的对话框里 */
  dialogs: ReactNode
}

export function useRestart(deviceId: string): RestartFlow {
  const { channel } = useServices()
  const device = useKey<DeviceView>(keys.device(deviceId))
  const t = useT()
  /** 列出来等确认的会话。null：没在问 */
  const [asking, setAsking] = useState<ServiceRestartSession[] | null>(null)
  const name = device ? t.text(device.name) : ''

  const rejected = (error: unknown) =>
    showToast({
      id: `restart:${deviceId}`,
      tone: 'err',
      lifeMs: 6000,
      text: () => (error instanceof Error ? error.message : String(error)),
    })
  const send = (mode: Mode) => {
    channel.command('device.restartService', { deviceId, mode }).catch(rejected)
  }
  const begin = () => {
    channel.command('device.restartSessions', { deviceId }).then(({ sessions }) => {
      if (sessions.length > 0) setAsking(sessions)
      else send('start')
    }, rejected)
  }

  const phase = device?.restart?.phase ?? null
  // biome-ignore lint/correctness/useExhaustiveDependencies: 只在换了一步时提示，名字、语言变了不再提示
  useEffect(() => {
    if (!phase || (phase.step !== 'done' && phase.step !== 'failed')) return
    const key = `${deviceId}:${phase.at}`
    if (told.has(key)) return
    told.add(key)
    showToast(resultToast(deviceId, name, phase, begin))
  }, [phase])

  const dialogs = (
    <>
      {asking ? (
        <Confirm
          title={t('restart.confirm.title', { name })}
          note={t('restart.confirm.note')}
          yes={t('restart.confirm.yes')}
          no={t('restart.confirm.no')}
          onYes={() => {
            setAsking(null)
            send('force')
          }}
          onClose={() => setAsking(null)}
        >
          <ul className="svc-busy" data-restart="sessions">
            {asking.slice(0, LISTED).map((entry) => (
              <li key={entry.id} data-session={entry.id}>
                {t.text(entry.title)}
                <span className="dim">
                  {' · '}
                  {entry.running
                    ? t('restart.confirm.turn')
                    : t('restart.confirm.background', { count: entry.background })}
                </span>
              </li>
            ))}
            {asking.length > LISTED ? (
              <li className="dim">
                {t('restart.confirm.more', { count: asking.length - LISTED })}
              </li>
            ) : null}
          </ul>
        </Confirm>
      ) : null}
      {phase?.step === 'busy' ? (
        <Confirm
          title={t('restart.busy.title', { name })}
          note={t('restart.busy.note')}
          yes={t('restart.busy.yes')}
          no={t('restart.confirm.no')}
          onYes={() => send('force')}
          onClose={() => send('dismiss')}
        >
          <ul className="svc-busy" data-restart="busy">
            {phase.busy.map((entry) => {
              const line = busyLine(entry, (id) => nameOf(device, id), t('list.comma'))
              return (
                <li key={`${entry.reason}:${entry.harnesses.join(',')}`} data-busy={entry.reason}>
                  {t(line.key, line.args)}
                </li>
              )
            })}
          </ul>
        </Confirm>
      ) : null}
    </>
  )
  return { begin, dialogs }
}

/** 做完了的那条提示：成了几秒后自己消失；没成的留着，带“重试” */
function resultToast(
  deviceId: string,
  name: string,
  phase: Extract<ServiceRestartPhase, { step: 'done' | 'failed' }>,
  again: () => void,
): Toast {
  const id = `restart:${deviceId}`
  if (phase.step === 'done') {
    return {
      id,
      lifeMs: 6000,
      text: (t: Translator) =>
        phase.interrupted > 0
          ? t('restart.done.interrupted', { name, count: phase.interrupted })
          : t('restart.done', { name }),
    }
  }
  return {
    id,
    tone: 'err',
    lifeMs: 0,
    text: (t: Translator) => {
      const reason = t(restartFailureKey(phase.reason))
      const said = phase.text ? t.text(phase.text) : null
      return t('restart.failed', {
        name,
        reason: said ? t('restart.failed.because', { reason, said }) : reason,
      })
    },
    action: { label: (t: Translator) => t('restart.again'), run: again },
  }
}
