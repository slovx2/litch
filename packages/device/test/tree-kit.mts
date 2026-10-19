// 会话树测试共用的搭法：两个假引擎（pi、claude-code），客户端声明 sessionTree 的和不声明的，
// 在 pi 上建一个父会话、发一个用户回合。
import assert from 'node:assert/strict'
import type { DeviceOptions } from '../src/device.mjs'
import type { SessionTiming } from '../src/session.mjs'
import { FakeControl, managed } from './fake-control.mjs'
import { FakeEngine } from './fake-engine.mjs'
import { rig, type TestClient } from './helpers.mjs'

/** Litch 客户端声明的扩展 */
export const TREE = ['harness', 'deviceWorkspaces', 'sessionTree', 'clientTools']
export const SESSIONS = 'litch_sessions'
/** 客户端建会话时带的一个自己的工具（子会话照样要带上） */
export const ECHO_SPEC = {
  type: 'namespace',
  name: 'litch_echo',
  description: 'echo',
  tools: [{ type: 'function', name: 'echo', description: 'echo', inputSchema: { type: 'object' } }],
}

export function treeRig(
  timing: Partial<SessionTiming> = {},
  more: Partial<DeviceOptions> & { values?: Record<string, unknown> } = {},
) {
  const pi = new FakeEngine('pi')
  const claude = new FakeEngine('claude-code')
  const fakes: Record<string, FakeEngine> = { pi, 'claude-code': claude }
  let control: FakeControl | null = null
  if (more.values) {
    control = new FakeControl([managed('pi'), managed('claude-code')], false)
    control.patch({ values: more.values as never })
  }
  const env = rig(
    control ? {} : fakes,
    { needsUserMs: 60, ...timing },
    {
      ...more,
      ...(control
        ? {
            control,
            dial: (socket: string) =>
              (fakes[socket.slice('fake://'.length)] as FakeEngine).connector,
          }
        : {}),
    },
  )
  return { ...env, pi, claude, control }
}

export type TreeEnv = ReturnType<typeof treeRig>

/** 声明了 sessionTree 的 Litch 客户端 */
export async function litch(env: TreeEnv): Promise<TestClient> {
  const client = env.connect()
  await client.initialize(TREE, { litchClientTools: { namespaces: ['litch_echo'] } })
  return client
}

/** 只声明了聚合面要求的扩展的客户端（像别的、旧的客户端） */
export async function plain(env: TreeEnv): Promise<TestClient> {
  const client = env.connect()
  await client.initialize(['harness'])
  return client
}

export const text = (value: string) => [{ type: 'text', text: value, text_elements: [] }]

/** 在 pi 上建一个父会话，带着客户端自己的工具；userTurn 为 true 再发一个用户回合 */
export async function parent(
  client: TestClient,
  userTurn = true,
): Promise<{ threadId: string; turnId: string | null }> {
  const started = await client.call('thread/start', {
    harness: 'pi',
    cwd: '/work/app',
    dynamicTools: [ECHO_SPEC],
  })
  const threadId = started.thread.id as string
  if (!userTurn) return { threadId, turnId: null }
  const turn = await client.call('turn/start', { threadId, input: text('帮我派一个子会话') })
  return { threadId, turnId: turn.turn.id }
}

/** 等到条件成立（轮询），超时就失败 */
export async function until(check: () => boolean | Promise<boolean>, what: string, ms = 3000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.fail(`等了 ${ms} 毫秒，${what}`)
}

/** 这条连接收到的某种通知的参数 */
export const got = (client: TestClient, method: string): any[] =>
  client.notifications.filter((frame) => frame.method === method).map((frame) => frame.params)

/** 等这条连接收到某个会话的 thread/started */
export async function startedOn(client: TestClient, threadId: string): Promise<any> {
  return client.waitFor(
    (frame) => frame.method === 'thread/started' && (frame.params as any)?.thread?.id === threadId,
  )
}

/** 补一段说明，让模型的 start 的 fresh 简报够 freshPromptMinChars 字 */
const BRIEF_TAIL =
  '相关文件都在 /work/app 下面，先读一遍 README 和目录结构再动手。做完的标准：改动能通过已有的检查，结束时用两三句话说明改了什么、怎么验证的、还剩什么没做；需要用户拍板的事单独列出来，不要自己定。'

export const brief = (task: string) => `${task}${BRIEF_TAIL}`
