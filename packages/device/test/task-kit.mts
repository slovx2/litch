// 定时任务（deviceTasks 扩展）的测试用到的小工具：可控的时钟、按扩展定义校验线上的形状、
// 会跑回合的假引擎、搭一个带任务模块的设备。
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Ajv } from 'ajv'
import type { DeviceOptions } from '../src/device.mjs'
import type { TaskClock } from '../src/task-scheduler.mjs'
import type { FakeConnection } from './fake-upstream.mjs'
import { FakeUpstream } from './fake-upstream.mjs'
import { REPO, type Rig, rig, type TestClient } from './helpers.mjs'

/** 握手时声明的扩展：聚合面要求的 harness，加上定时任务 */
export const DECLARED = ['harness', 'deviceTasks']

// ---------- 按扩展定义校验 ----------
const definition = JSON.parse(
  readFileSync(join(REPO, 'protocol/extensions/device-tasks.json'), 'utf8'),
)
const ajv = new Ajv({ strict: false, allErrors: true })
const compiled = new Map<string, ReturnType<typeof ajv.compile>>()

function check(schema: unknown, value: unknown, what: string): void {
  const key = JSON.stringify(schema)
  let validate = compiled.get(key)
  if (!validate) {
    validate = ajv.compile({ ...(schema as object), definitions: definition.definitions })
    compiled.set(key, validate)
  }
  if (!validate(value))
    throw new Error(`${what} 和扩展定义对不上：${JSON.stringify(validate.errors)}`)
}

function part(kind: string, method?: string): any {
  const found = definition.parts.find(
    (item: any) => item.kind === kind && (method === undefined || item.method === method),
  )
  if (!found) throw new Error(`扩展定义里没有 ${kind} ${method ?? ''}`)
  return found
}

export const assertResponse = (method: string, value: unknown) =>
  check(part('ClientRequest', method).response, value, `${method} 的应答`)
export const assertParams = (method: string, value: unknown) =>
  check(part('ClientRequest', method).params, value, `${method} 的参数`)
export const assertNotification = (method: string, value: unknown) =>
  check(part('ServerNotification', method).params, value, `${method} 的通知`)
export const assertTaskErrorData = (value: unknown) =>
  check(part('Error').data, value, 'error.data')
export const taskErrorCode = (reason: string): number =>
  part('Error').errors.find((item: any) => item.litch === reason).code

// ---------- 时钟 ----------

/**
 * 墙钟是真的时间加上一段可以拨的偏移；调度的定时器只在 advance 时到点。
 * 回合里的等待（task-run.mts）用的是真的定时器，时限按这里的墙钟算，所以拨钟也能让回合超时。
 */
export class FakeClock implements TaskClock {
  offset = 0
  private readonly timers = new Map<number, { at: number; run: () => void }>()
  private sequence = 0

  now(): number {
    return Date.now() + this.offset
  }

  setTimer(run: () => void, ms: number): unknown {
    const id = ++this.sequence
    this.timers.set(id, { at: this.now() + ms, run })
    return id
  }

  clearTimer(handle: unknown): void {
    this.timers.delete(handle as number)
  }

  /** 拨快 ms 毫秒，到点的定时器按先后跑 */
  advance(ms: number): void {
    this.offset += ms
    for (;;) {
      const due = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= this.now())
        .sort((a, b) => a[1].at - b[1].at)[0]
      if (!due) return
      this.timers.delete(due[0])
      due[1].run()
    }
  }

  /** 还挂着的定时器离现在多久（毫秒），按先后 */
  pending(): number[] {
    return [...this.timers.values()].map((timer) => timer.at - this.now()).sort((a, b) => a - b)
  }
}

// ---------- 会跑回合的假引擎 ----------

export interface TurnScript {
  /** 回合结束时的状态。null：不结束，测试自己用 finish 结束 */
  status: 'completed' | 'failed' | 'interrupted' | null
  /** 最后一条回答 */
  answer?: string
}

/** 一个回合：在哪条连接上开始的，结束时在那条连接上发通知 */
export interface FakeTurn {
  threadId: string
  turnId: string
  connection: FakeConnection
  params: any
}

/**
 * 假的适配器引擎：会建会话、改名、发回合。回合怎么结束由 script 定（默认立刻完成，回答“完成了”）。
 * 所有回合记在 turns 里；thread/read 带 includeTurns 时回合的结果也在里面
 */
export class TaskEngine extends FakeUpstream {
  script: (params: any) => TurnScript = () => ({ status: 'completed', answer: '完成了' })
  readonly turns: FakeTurn[] = []
  /** 回合的结果，thread/read 里给 */
  readonly results = new Map<string, Record<string, unknown>>()
  private serial = 0

  constructor(engine = 'pi') {
    super(engine)
    this.handlers['thread/name/set'] = (params) => {
      const thread = this.threads.find((item) => item.id === params.threadId)
      if (thread) thread.name = params.name
      return {}
    }
    this.handlers['turn/start'] = (params, connection) => {
      const turnId = `turn-${++this.serial}`
      const turn = { threadId: params.threadId, turnId, connection, params }
      this.turns.push(turn)
      this.results.set(turnId, { id: turnId, status: 'inProgress', items: [] })
      const script = this.script(params)
      if (script.status !== null)
        setImmediate(() => this.finish(turn, script.status ?? 'completed', script.answer))
      return { turn: { id: turnId, status: 'inProgress', items: [] } }
    }
    this.handlers['turn/interrupt'] = (params) => {
      const turn = this.turns.find((item) => item.turnId === params.turnId)
      if (turn) setImmediate(() => this.finish(turn, 'interrupted'))
      return {}
    }
    this.handlers['thread/read'] = (params) => {
      const thread = this.threads.find((item) => item.id === params.threadId)
      if (!thread) throw new Error('未知会话')
      const turns = params.includeTurns
        ? this.turns
            .filter((turn) => turn.threadId === thread.id)
            .map((turn) => this.results.get(turn.turnId))
        : []
      return { thread: { ...thread, turns } }
    }
  }

  /** 让一个回合结束：先发最后一条回答，再发 turn/completed（发给每条连着的连接，恢复了会话的也收得到） */
  finish(turn: FakeTurn, status: string, answer?: string): void {
    const items = answer ? [{ type: 'agentMessage', id: `${turn.turnId}-a`, text: answer }] : []
    this.results.set(turn.turnId, { id: turn.turnId, status, items })
    for (const item of items)
      this.notify('item/completed', { threadId: turn.threadId, turnId: turn.turnId, item })
    this.notify('turn/completed', {
      method: 'turn/completed',
      threadId: turn.threadId,
      turn: {
        id: turn.turnId,
        status,
        items: [],
        ...(status === 'failed' ? { error: { message: '模型出错了' } } : {}),
      },
    })
  }
}

// ---------- 设备 ----------

export interface TaskRig extends Rig {
  clock: FakeClock
}

/** 搭一个带任务模块的设备：可控的时钟，回合的时限可以改短 */
export function taskRig(
  upstreams: Record<string, FakeUpstream>,
  more: Partial<DeviceOptions> = {},
  clock = new FakeClock(),
): TaskRig {
  const built = rig(upstreams, {}, { ...more, tasks: { clock, ...more.tasks } })
  return { ...built, clock }
}

/** 等到条件成立，最多等 timeoutMs */
export async function until(
  what: string,
  check: () => boolean | Promise<boolean>,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`等了 ${timeoutMs} 毫秒，${what} 还没有成立`)
}

/** 握手（声明 deviceTasks），返回这条连接 */
export async function tasksClient(target: Rig): Promise<TestClient> {
  const client = target.connect()
  await client.initialize(DECLARED)
  return client
}

/** 一个每隔 minutes 分钟、在新会话里跑的任务的参数 */
export function intervalTask(cwd: string, minutes = 5, more: Record<string, unknown> = {}) {
  return {
    name: '整理日报',
    prompt: '把今天的提交整理成日报。',
    schedule: { type: 'interval', minutes },
    timezone: 'Asia/Shanghai',
    target: {
      kind: 'newThread',
      harness: 'pi',
      cwd,
      workspaceId: null,
      settings: { model: null, effort: null, permission: null },
    },
    ...more,
  }
}
