import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import {
  PRESENTATION_RULES,
  PRESENTATION_SPEC,
} from '../../protocol/src/client-tools-presentation.mjs'
import type { RpcPeer } from '../../shared/src/types.mjs'
import { clientToolInstructions, clientTools } from '../src/dynamic-tools.mjs'
import { PiServer } from '../src/server.mjs'
import { approvalHarness, pause } from './approval-harness.mjs'

// 命名空间带的 instructions（clientTools 扩展）接在 Pi 系统提示的最后：用户自己的 APPEND_SYSTEM.md 照旧在、
// 排在前面；新建、分叉、适配器重启后恢复的会话都有，只有一份。真实 Pi SDK 加回环上的假模型。

const USER = 'USER-APPEND-SYSTEM-MARK'
const RULES = 'RULES-FOR-SESSIONS-PI: propose cards for follow-up work.'
const TOOLS = [
  {
    type: 'namespace',
    name: 'litch_echo',
    description: 'Litch 测试工具',
    instructions: RULES,
    tools: [
      {
        type: 'function',
        name: 'echo',
        description: '原样回参数',
        inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
      },
    ],
  },
]

const count = (text: string, needle: string) => text.split(needle).length - 1

/** 一次模型请求里的系统提示（openai-completions：system 或 developer 角色的消息） */
const systemOf = (body: any): string =>
  JSON.stringify(
    (body.messages ?? []).filter((m: any) => m.role === 'system' || m.role === 'developer'),
  )

function assertRules(body: any) {
  const system = systemOf(body)
  assert.equal(count(system, RULES), 1, system)
  assert.equal(count(system, USER), 1, system)
  assert.ok(system.indexOf(USER) < system.indexOf(RULES), '规则在用户的追加提示之后')
}

test('TOOL-INSTRUCTIONS-PI-001：新建、分叉、重启后恢复的会话，系统提示末尾都有规则，用户的追加提示还在', {
  timeout: 120_000,
}, async () => {
  const h = await approvalHarness({
    approvals: false,
    prepare: (agentDir) => writeFile(join(agentDir, 'APPEND_SYSTEM.md'), USER),
  })
  let restarted: PiServer | null = null
  try {
    const c = await h.connect('desktop', ['clientTools'])
    const { thread } = await c.ok('thread/start', {
      cwd: h.cwd,
      model: 'gate/gate',
      dynamicTools: TOOLS,
    })
    await c.completed(await c.start(thread.id, '第一句'))
    assertRules(h.requests.at(-1))
    await c.completed(await c.start(thread.id, '第二句'))
    assertRules(h.requests.at(-1))

    const { thread: fork } = await c.ok('thread/fork', { threadId: thread.id })
    await c.completed(await c.start(fork.id, '分叉之后'))
    assertRules(h.requests.at(-1))

    // 适配器重启：会话从记下的工具重新装载
    await h.shutdown()
    restarted = new PiServer(join(h.root, 'state'), { approvals: false })
    const messages: any[] = []
    const peer: RpcPeer = { id: 'again', close() {}, send: (m) => void messages.push(m) }
    let id = 0
    const ok = async (method: string, params: unknown) => {
      const requestId = ++id
      await restarted?.handle(peer, { jsonrpc: '2.0', id: requestId, method, params } as any)
      const reply = messages.find((m) => m.id === requestId && !m.method)
      assert.equal(reply?.error, undefined, JSON.stringify(reply?.error))
      return reply.result
    }
    await ok('initialize', { clientInfo: { name: 'again', version: '0' }, capabilities: null })
    await ok('thread/resume', { threadId: thread.id })
    const asked = h.requests.length
    const { turn } = await ok('turn/start', {
      threadId: thread.id,
      input: [{ type: 'text', text: '重启之后' }],
    })
    for (let waited = 0; waited < 20_000; waited += 20) {
      if (messages.some((m) => m.method === 'turn/completed' && m.params.turn.id === turn.id)) break
      await pause(20)
    }
    assert.ok(h.requests.length > asked, '重启之后没有请求模型')
    assertRules(h.requests.at(-1))
  } finally {
    await restarted?.close()
    await h.dispose()
  }
})

test('TOOL-INSTRUCTIONS-PI-002：同一段 instructions 只放一次，没有就是 null', () => {
  const again = { ...TOOLS[0], name: 'litch_other' }
  assert.equal(
    clientToolInstructions([TOOLS[0], again]),
    `# Tool instructions: litch_echo\n${RULES}`,
  )
  assert.equal(clientToolInstructions([{ ...TOOLS[0], instructions: ' ' }]), null)
  assert.equal(clientToolInstructions([]), null)
})

test('TOOL-INSTRUCTIONS-PI-003：Litch 的呈现风格（不带工具的命名空间）排在工具的规则后面，不多出工具', () => {
  assert.equal(
    clientToolInstructions([TOOLS[0], PRESENTATION_SPEC]),
    `# Tool instructions: litch_echo\n${RULES}\n\n# Tool instructions: litch_presentation\n${PRESENTATION_RULES}`,
  )
  assert.deepEqual(
    clientTools([TOOLS[0], PRESENTATION_SPEC]).map((tool) => tool.namespace),
    ['litch_echo'],
  )
})
