// 模拟核心里的后台任务（backgroundTasks 扩展，model-background.mts）：
// 对话里说“后台任务”（英文 background tasks）：模型起两条后台命令（dev 服务、测试），回一句就停下，
// 回合结束时两条都还在跑（会话照样是空闲，侧栏摘要上的集合有两个在跑）；
// 过一会儿测试先跑完，harness 自己接着做（自发回合，来历 backgroundTask，没有用户消息）；
// 再过一会儿 dev 服务退出（退出码 1，记失败），这次不再接着做。
// 条目的显示标识照真的核心写成“回合:协议条目标识”，集合里的 itemId 是协议那一截。
import type { SessionOp } from '../channel/protocol.mjs'
import type { ItemView, OutgoingMessage, SessionSummary, SessionView } from '../model.mjs'
import type { BackgroundTaskView } from '../model-background.mjs'
import type { SampleLang } from './sample-text.mjs'

const STARTS = /后台任务|background tasks/i

/** 测试多久跑完、dev 服务多久退出（按模拟的时钟，从起命令那一刻算） */
export const BACKGROUND_FIRST_MS = 4000
export const BACKGROUND_SECOND_MS = 9000

const TEXT = {
  'zh-CN': {
    started: '两个后台任务在跑：dev 服务和测试。跑完了我会接着看。',
    woke: '测试跑完了：48 个用例全部通过。dev 服务还在后台跑着。',
    testOutput: '共 48 项测试，全部通过\n',
    devOutput: '端口 5173 被占用，退出\n',
  },
  en: {
    started:
      'Two background tasks are running: the dev server and the tests. I will pick up when they finish.',
    woke: 'The tests finished: all 48 passed. The dev server is still running in the background.',
    testOutput: '48 tests, all passed\n',
    devOutput: 'Port 5173 is in use, exiting\n',
  },
} as const

export interface MockBackgroundHost {
  lang: SampleLang
  now(): number
  setTimer(run: () => void, ms: number): () => void
  summary(deviceId: string, sessionId: string): SessionSummary | undefined
  updateSummary(deviceId: string, sessionId: string, patch: Partial<SessionSummary>): void
  apply(view: SessionView, ops: SessionOp[]): void
  /** 在回合里流出一段回答，流完回合结束 */
  reply(view: SessionView, turnId: string, text: string): void
  nextId(prefix: string): string
}

export interface MockBackground {
  /** 这条消息是不是后台任务这一出：是的话由这里接着演，返回 true */
  claim(view: SessionView, turnId: string, message: OutgoingMessage): boolean
}

export function createMockBackground(host: MockBackgroundHost): MockBackground {
  const text = TEXT[host.lang]

  /** 把一个任务换成新的样子，整份写回侧栏摘要（和真的变化通知一样整份替换） */
  const put = (view: SessionView, task: BackgroundTaskView) => {
    const before = host.summary(view.deviceId, view.sessionId)?.background?.tasks ?? []
    const others = before.filter((entry) => entry.id !== task.id)
    const all = [...others, task]
    const running = all
      .filter((entry) => entry.status === 'running')
      .sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0))
    const ended = all
      .filter((entry) => entry.status !== 'running')
      .sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))
    const tasks = [...running, ...ended]
    host.updateSummary(view.deviceId, view.sessionId, {
      background: { tasks, running: running.length, wakesOnFinish: true },
    })
  }

  const command = (turnId: string, id: string, line: string, startedAt: number): ItemView => ({
    id: `${turnId}:${id}`,
    kind: 'command',
    command: line,
    cwd: '~',
    output: '',
    elided: null,
    exitCode: null,
    durationMs: null,
    startedAt,
    status: 'inProgress',
  })

  /** 一条后台命令结束：条目定稿，集合里记成完成或失败 */
  const end = (
    view: SessionView,
    turnId: string,
    item: ItemView,
    task: BackgroundTaskView,
    output: string,
    exitCode: number,
  ) => {
    if (item.kind !== 'command') return
    const now = host.now()
    host.apply(view, [
      {
        op: 'item.add',
        turnId,
        item: {
          ...item,
          output,
          exitCode,
          durationMs: now - (item.startedAt ?? now),
          status: exitCode === 0 ? 'completed' : 'failed',
        },
      },
    ])
    put(view, { ...task, status: exitCode === 0 ? 'completed' : 'failed', endedAt: now })
  }

  /** 后台任务结束后 harness 自己开的一轮：没有用户消息，回合上记着来历 */
  const wake = (view: SessionView) => {
    const turnId = host.nextId('bgw')
    host.apply(view, [
      {
        op: 'turn.add',
        turn: {
          id: turnId,
          status: 'running',
          itemIds: [],
          startedAt: host.now(),
          durationMs: null,
          error: null,
          origin: 'backgroundTask',
        },
      },
    ])
    host.updateSummary(view.deviceId, view.sessionId, { status: 'running', updatedAt: host.now() })
    host.reply(view, turnId, text.woke)
  }

  return {
    claim(view, turnId, message) {
      if (!STARTS.test(message.text)) return false
      const now = host.now()
      const dev = command(turnId, 'bg-dev', 'npm run dev', now)
      const tests = command(turnId, 'bg-test', 'npm test -- --reporter dot', now + 1)
      host.apply(view, [
        { op: 'item.add', turnId, item: dev },
        { op: 'item.add', turnId, item: tests },
      ])
      const task = (item: ItemView, startedAt: number): BackgroundTaskView => ({
        id: item.id,
        kind: 'shell',
        title: item.kind === 'command' ? item.command : '',
        status: 'running',
        itemId: item.id.slice(turnId.length + 1),
        turnId,
        startedAt,
        endedAt: null,
      })
      const devTask = task(dev, now)
      const testTask = task(tests, now + 1)
      put(view, devTask)
      put(view, testTask)
      host.reply(view, turnId, text.started)
      host.setTimer(() => {
        end(view, turnId, tests, testTask, text.testOutput, 0)
        wake(view)
      }, BACKGROUND_FIRST_MS)
      host.setTimer(() => end(view, turnId, dev, devTask, text.devOutput, 1), BACKGROUND_SECOND_MS)
      return true
    },
  }
}
