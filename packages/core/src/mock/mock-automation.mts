// 模拟核心的电脑操作预览（侧面板“电脑预览”、固定画中画）：对话里说“电脑预览”，这个会话就有一个在被操作的窗口，
// 每秒来一帧（画面是 sample-automation.mts 那一张），代理光标停在正文里。同一句话里再带这些字样换状态：
//   “前台”：已短暂切到前台；“等空闲”：等待键鼠空闲；“等画面”：还没有画面、等系统授权；
//   “采集失败”：窗口采集中断；“恢复失败”：没能切回原来的前台窗口。
// 面板上的“停止”去掉预览，“固定画中画”“返回面板”切换 pinned，“接管窗口”只记下不动。

import type {
  AutomationPreviewCommand,
  AutomationPreviewView,
} from '../automation-preview/model.mjs'
import type { Clock } from '../channel/protocol.mjs'
import type { HostSink } from '../channel/server.mjs'
import { SAMPLE_AUTOMATION_FRAME } from './sample-automation.mjs'

const PREVIEW = /电脑预览|computer preview/i

const STATUS: readonly [RegExp, string][] = [
  [/等空闲|wait for idle/i, 'waitingForIdle'],
  [/等画面|capture pending/i, 'capturePending'],
  [/采集失败|capture failed/i, 'captureFailed'],
  [/恢复失败|restore failed/i, 'restoreFailed'],
]

export interface MockAutomation {
  /** 对话里说了“电脑预览”就认下（回合照常往下走） */
  stage(deviceId: string, sessionId: string, text: string): void
  subscribe(deviceId: string, sessionId: string, sink: HostSink): () => void
  command(params: AutomationPreviewCommand): Record<string, never>
}

export function createMockAutomation(clock: Clock): MockAutomation {
  const views = new Map<string, AutomationPreviewView>()
  const sinks = new Map<string, Set<HostSink>>()
  const timers = new Map<string, () => void>()
  const keyOf = (deviceId: string, sessionId: string) => `${deviceId}:${sessionId}`

  const publish = (key: string) => {
    for (const sink of sinks.get(key) ?? []) sink.snapshot(views.get(key) ?? null)
  }
  /** 有人看着、又有画面的时候每秒来一帧，界面不会说“画面暂无更新” */
  const tick = (key: string) => {
    const view = views.get(key)
    if (!view?.frame || !sinks.get(key)?.size) {
      timers.delete(key)
      return
    }
    views.set(key, {
      ...view,
      frame: { ...view.frame, seq: view.frame.seq + 1, receivedAt: clock.now() },
      updatedAt: clock.now(),
    })
    publish(key)
    timers.set(
      key,
      clock.setTimer(() => tick(key), 1000),
    )
  }
  const arm = (key: string) => {
    if (!timers.has(key) && views.get(key)?.frame && sinks.get(key)?.size)
      timers.set(
        key,
        clock.setTimer(() => tick(key), 1000),
      )
  }
  const disarm = (key: string) => {
    timers.get(key)?.()
    timers.delete(key)
  }

  return {
    stage(deviceId, sessionId, text) {
      if (!PREVIEW.test(text)) return
      const key = keyOf(deviceId, sessionId)
      const status = STATUS.find(([pattern]) => pattern.test(text))?.[1] ?? 'running'
      const visible = status !== 'capturePending'
      const now = clock.now()
      const version = {
        surfaceId: 'mock-notes',
        executorId: 'mock',
        generation: 1,
        geometryRevision: 1,
      }
      views.set(key, {
        owner: { deviceId, sessionId },
        app: '备忘录',
        surface: visible ? { ...version, kind: 'nativeWindow', width: 640, height: 440 } : null,
        pointer: visible
          ? {
              ...version,
              actionId: 'mock-click',
              seq: 1,
              timeUs: now * 1000,
              phase: 'completed',
              kind: 'click',
              position: { x: 412, y: 150 },
              button: 'left',
            }
          : null,
        frame: visible
          ? {
              streamId: 'mock',
              seq: 1,
              data: SAMPLE_AUTOMATION_FRAME,
              mime: 'image/jpeg',
              receivedAt: now,
              pixelWidth: 640,
              pixelHeight: 440,
              contentRect: { x: 0, y: 0, width: 640, height: 440 },
              cursorComposited: false,
            }
          : null,
        status,
        foreground: /前台|foreground/i.test(text),
        pinned: false,
        updatedAt: now,
      })
      publish(key)
      arm(key)
    },

    subscribe(deviceId, sessionId, sink) {
      const key = keyOf(deviceId, sessionId)
      const set = sinks.get(key) ?? new Set<HostSink>()
      sinks.set(key, set)
      set.add(sink)
      sink.snapshot(views.get(key) ?? null)
      arm(key)
      return () => {
        set.delete(sink)
        if (set.size === 0) disarm(key)
      }
    },

    command({ deviceId, sessionId, action }) {
      const key = keyOf(deviceId, sessionId)
      const view = views.get(key)
      if (!view) return {}
      if (action === 'stop') {
        views.delete(key)
        disarm(key)
      } else if (action === 'pin' || action === 'unpin') {
        views.set(key, { ...view, pinned: action === 'pin', updatedAt: clock.now() })
      } else return {}
      publish(key)
      return {}
    },
  }
}
