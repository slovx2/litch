import assert from 'node:assert/strict'
import test from 'node:test'
import {
  PRESENTATION_RULES,
  PRESENTATION_SPEC,
} from '../../protocol/src/client-tools-presentation.mjs'
import { ECHO_TOOLS } from '../../protocol/src/client-tools-specs.mjs'
import { dynamicToolSpecs, toolInstructions } from '../src/client-tools.mjs'
import { client, isolate, skip, text, violations } from './client.mjs'
import { scripted } from './mock-model.mjs'

// 命名空间带的 instructions（clientTools 扩展）经会话自己的 MCP 服务的 initialize 说明交给 OpenCode，
// 进系统提示的 <mcp_instructions>：在用户的 AGENTS.md 之后，只有一份；同一目录下别的会话（哪怕也带着动态工具）
// 看不到；分叉出来的会话带着。真实的 opencode serve 加回环假模型。

const USER = 'USER-AGENTS-MD-MARK-OC'
const RULES = 'RULES-FOR-SESSIONS-OC: propose cards for follow-up work.'
const TOOLS = [{ ...ECHO_TOOLS, instructions: RULES }]
const count = (value: string, needle: string) => value.split(needle).length - 1

/** 一次模型请求里的系统提示（openai 兼容接口：system 角色的消息） */
const systemOf = (body: any): string =>
  JSON.stringify((body.messages ?? []).filter((m: any) => m.role === 'system'))

test('OpenCode 的规则：会话自己的系统提示里有一份、在 AGENTS.md 之后；别的会话没有；分叉出来的有', {
  skip,
  timeout: 180000,
}, async () => {
  const env = await isolate(scripted({}), { files: { 'AGENTS.md': USER } })
  try {
    const desktop = client(env.server)
    await desktop.call('initialize', {
      clientInfo: { name: 'litch', version: '0' },
      capabilities: {
        litchExtensions: ['clientTools'],
        litchClientTools: { namespaces: ['litch_echo'] },
      },
    })
    // 一次回合里发给模型的、带工具的最后那次请求（不是起标题的）
    const turn = async (threadId: string, said: string) => {
      const before = env.model.requests.length
      const { turn } = await desktop.call('turn/start', { threadId, input: text(said) })
      await desktop.until('turn/completed', (p) => p.turn.id === turn.id, 60000)
      const sent = env.model.requests.slice(before).filter((body) => body.tools?.length)
      assert.ok(sent.length > 0, '没有请求模型')
      return systemOf(sent.at(-1))
    }
    const owned = (system: string) => {
      assert.equal(count(system, RULES), 1, system)
      assert.equal(count(system, USER), 1, system)
      assert.ok(system.indexOf(USER) < system.indexOf(RULES), '规则在 AGENTS.md 之后')
    }

    const { thread } = await desktop.call('thread/start', { cwd: env.cwd, dynamicTools: TOOLS })
    owned(await turn(thread.id, '第一句'))
    owned(await turn(thread.id, '第二句'))

    // 同一目录下带着别的动态工具（没有规则）的会话、什么都没带的会话：都看不到这份
    const { thread: other } = await desktop.call('thread/start', {
      cwd: env.cwd,
      dynamicTools: [ECHO_TOOLS],
    })
    assert.equal(count(await turn(other.id, '别的会话'), RULES), 0)
    const { thread: bare } = await desktop.call('thread/start', { cwd: env.cwd })
    const plain = await turn(bare.id, '没带工具')
    assert.equal(count(plain, RULES), 0)
    assert.equal(count(plain, USER), 1)

    const { thread: fork } = await desktop.call('thread/fork', { threadId: thread.id })
    owned(await turn(fork.id, '分叉之后'))
  } finally {
    await env.restore()
  }
  assert.deepEqual([...violations], [])
})

test('OpenCode 的规则：同一段只放一次，没有就是 null', () => {
  assert.equal(
    toolInstructions([TOOLS[0], { ...TOOLS[0], name: 'litch_other' }]),
    `# Tool instructions: litch_echo\n${RULES}`,
  )
  assert.equal(toolInstructions([ECHO_TOOLS]), null)
  assert.equal(toolInstructions(undefined), null)
})

test('OpenCode：Litch 的呈现风格（不带工具的命名空间）进 MCP 服务的 instructions、排在工具的规则后面，不多出工具', () => {
  assert.equal(
    toolInstructions([TOOLS[0], PRESENTATION_SPEC]),
    `# Tool instructions: litch_echo\n${RULES}\n\n# Tool instructions: litch_presentation\n${PRESENTATION_RULES}`,
  )
  assert.deepEqual(
    dynamicToolSpecs([ECHO_TOOLS, PRESENTATION_SPEC]).map((spec) => spec.namespace),
    ['litch_echo'],
  )
})
