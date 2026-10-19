import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { ECHO_TOOLS } from '../../protocol/src/client-tools-specs.mjs'
import { EXTENSION, EXTENSIONS_CAPABILITY } from '../../protocol/src/device.mjs'
import { dshToolInstructions } from '../src/client-tools.mjs'
import { DshServer } from '../src/server.mjs'
import { client, isolate, violations } from './client.mjs'

// 命名空间带的 instructions（clientTools 扩展）经插进 dsh 的插件作为只对这个会话可见的一节放进系统提示末尾：
// 用户自己的 AGENTS.md 照旧在；别的会话没有；适配器（连同 dsh）重启、恢复会话后还在，只有一份。
// 真实的 dsh（0.2.0-rc.2）加回环假模型。

const USER = 'USER-AGENTS-MD-MARK'
const RULES = 'RULES-FOR-SESSIONS-DSH: propose cards for follow-up work.'
const TOOLS = [{ ...ECHO_TOOLS, instructions: RULES }]
const text = (value: string) => [{ type: 'text', text: value, text_elements: [] }]
const declaring = {
  clientInfo: { name: 'litch', version: '0' },
  capabilities: {
    [EXTENSIONS_CAPABILITY]: [EXTENSION.clientTools],
    litchClientTools: { namespaces: ['litch_echo'] },
  },
}
const count = (value: string, needle: string) => value.split(needle).length - 1

test('dsh 的规则：系统提示末尾有一份，用户的 AGENTS.md 还在；没带工具的会话没有；重启恢复后照旧', {
  timeout: 300000,
}, async () => {
  const env = await isolate((body) =>
    body.tools?.length
      ? [{ type: 'text', chunks: ['好的。'] }]
      : [{ type: 'text', chunks: ['标题'] }],
  )
  const home = join(env.root, 'home')
  await mkdir(join(home, 'dsh-home'), { recursive: true })
  await writeFile(join(home, 'dsh-home', 'AGENTS.md'), USER)
  let server = new DshServer(home)
  // 一次回合里发给模型的、带工具的那次请求（不是起标题的）
  const turn = async (desktop: ReturnType<typeof client>, threadId: string, said: string) => {
    const before = env.model.requests.length
    const { turn } = await desktop.call('turn/start', { threadId, input: text(said) })
    await desktop.until(
      'turn/completed',
      (params) => params.threadId === threadId && params.turn.id === turn.id,
    )
    const sent = env.model.requests.slice(before).filter((body) => body.tools?.length)
    assert.ok(sent.length > 0, '没有请求模型')
    return sent.at(-1)
  }
  try {
    const desktop = client(server)
    await desktop.call('initialize', declaring)
    const { thread } = await desktop.call('thread/start', { cwd: env.cwd, dynamicTools: TOOLS })
    const check = (body: any) => {
      const system = JSON.stringify(body.system ?? '')
      assert.equal(count(system, RULES), 1, system)
      // 排在系统提示的最后（dsh 把用户的 AGENTS.md 放在消息里，不在系统提示里）
      assert.ok(system.endsWith(`${RULES}"`) || system.endsWith(`${RULES}"}]`), system.slice(-200))
      assert.equal(count(JSON.stringify(body), USER), 1, '用户的 AGENTS.md 还在')
    }
    check(await turn(desktop, thread.id, '第一句'))
    check(await turn(desktop, thread.id, '第二句'))

    const bare = await desktop.call('thread/start', { cwd: env.cwd })
    const plain = await turn(desktop, bare.thread.id, '没带工具')
    assert.equal(count(JSON.stringify(plain), RULES), 0)

    await server.close()
    server = new DshServer(home)
    const again = client(server)
    await again.call('initialize', declaring)
    await again.call('thread/resume', { threadId: thread.id })
    check(await turn(again, thread.id, '重启以后'))
    assert.deepEqual([...violations], [])
  } finally {
    await server.close()
    await env.restore()
  }
})

test('dsh 的规则：同一段只放一次，没有就是 null', () => {
  assert.equal(
    dshToolInstructions([TOOLS[0], { ...TOOLS[0], name: 'litch_other' }]),
    `# Tool instructions: litch_echo\n${RULES}`,
  )
  assert.equal(dshToolInstructions([ECHO_TOOLS]), null)
  assert.equal(dshToolInstructions(undefined), null)
})
