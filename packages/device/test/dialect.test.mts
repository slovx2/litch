// 上游的“方言”（dialect.mts）：转给原生 codex 之前，动态工具的命名空间带的 instructions 摘掉、并进开发者指令；
// 适配器的运行时原样拿到这个字段（入口自己拼进系统提示）。
import assert from 'node:assert/strict'
import test from 'node:test'
import { SESSION_PROPOSAL_RULES, SESSION_TOOLS } from '../../protocol/src/client-tools-sessions.mjs'
import { ECHO_TOOLS } from '../../protocol/src/client-tools-specs.mjs'
import { codexVerdict } from '../../shared/test/codex-params.mjs'
import { ADAPTER_DIALECT, foldToolInstructions } from '../src/dialect.mjs'
import { codexRig, sentTo } from './codex-kit.mjs'
import { codexThread } from './fake-codex.mjs'

const USER = 'User developer instructions.'
const RULES = `# Tool instructions: litch_sessions\n${SESSION_PROPOSAL_RULES}`
const THREAD = codexThread(1, 400).id

test('DIALECT-001：instructions 摘掉，拼在用户的开发者指令后面；别的字段、别的工具不动', () => {
  const params = {
    cwd: '/work',
    developerInstructions: `${USER}\n`,
    dynamicTools: [ECHO_TOOLS, SESSION_TOOLS],
  }
  const folded = foldToolInstructions('thread/start', params)
  assert.ok(folded)
  assert.equal(folded.developerInstructions, `${USER}\n\n${RULES}`)
  assert.equal(folded.cwd, '/work')
  const tools = folded.dynamicTools as any[]
  assert.equal(tools[0], ECHO_TOOLS)
  const { instructions: _dropped, ...expected } = SESSION_TOOLS
  assert.deepEqual(tools[1], expected)
  assert.equal('instructions' in tools[1], false)
  // 原来那份参数没被改动
  assert.equal(params.dynamicTools[1], SESSION_TOOLS)
  assert.equal(params.developerInstructions, `${USER}\n`)
})

test('DIALECT-002：没给开发者指令时只有规则；已经含着这段规则的不再拼；空的 instructions 只摘不拼', () => {
  const alone = foldToolInstructions('thread/start', { dynamicTools: [SESSION_TOOLS] })
  assert.equal(alone?.developerInstructions, RULES)
  // 客户端把含着规则的那一份带回来（恢复时）：不叠第二份
  const again = foldToolInstructions('thread/resume', {
    threadId: 't',
    developerInstructions: `${USER}\n\n${RULES}`,
    dynamicTools: [SESSION_TOOLS],
  })
  assert.equal(again?.developerInstructions, `${USER}\n\n${RULES}`)
  const blank = foldToolInstructions('thread/start', {
    dynamicTools: [{ ...ECHO_TOOLS, instructions: '  ' }],
  })
  assert.deepEqual(blank, { dynamicTools: [ECHO_TOOLS] })
  // 同一段规则出现在两个命名空间里也只拼各自的一份，相同的不重复
  const twice = foldToolInstructions('thread/start', {
    dynamicTools: [SESSION_TOOLS, SESSION_TOOLS],
  })
  assert.equal(twice?.developerInstructions, RULES)
})

test('DIALECT-003：没有 instructions、不是建会话类的方法、适配器的方言：都不改', () => {
  assert.equal(foldToolInstructions('thread/start', { dynamicTools: [ECHO_TOOLS] }), null)
  assert.equal(foldToolInstructions('thread/start', { developerInstructions: USER }), null)
  assert.equal(foldToolInstructions('turn/start', { dynamicTools: [SESSION_TOOLS] }), null)
  assert.equal(ADAPTER_DIALECT.outgoing('thread/start', { dynamicTools: [SESSION_TOOLS] }), null)
})

test('DIALECT-004：经聚合面建原生 codex 的会话，到它手里的是并进开发者指令的规则，它收、不丢字段；恢复不叠加', async () => {
  const env = codexRig()
  try {
    const client = env.connect()
    await client.initialize(['harness', 'clientTools'], {
      litchClientTools: { namespaces: ['litch_echo'] },
    })
    await client.call('thread/start', {
      harness: 'codex',
      cwd: '/work/codex',
      permissions: ':workspace',
      developerInstructions: USER,
      dynamicTools: [ECHO_TOOLS, SESSION_TOOLS],
    })
    const [seen] = sentTo(env.codex, 'thread/start')
    assert.equal(seen.developerInstructions, `${USER}\n\n${RULES}`)
    assert.equal(
      seen.dynamicTools.some((spec: any) => 'instructions' in spec),
      false,
    )
    // 权限档配套的审批策略照旧配上
    assert.equal(seen.approvalPolicy, 'on-request')
    assert.deepEqual(codexVerdict('thread/start', seen), { rejects: [], ignored: [] })

    // 恢复：参数里没有工具，开发者指令原样（规则在会话历史里，上游不重放）
    await client.call('thread/resume', { threadId: THREAD, developerInstructions: USER })
    assert.equal(sentTo(env.codex, 'thread/resume').at(-1).developerInstructions, USER)
    await client.call('thread/resume', {
      threadId: THREAD,
      developerInstructions: `${USER}\n\n${RULES}`,
    })
    assert.equal(
      sentTo(env.codex, 'thread/resume').at(-1).developerInstructions,
      `${USER}\n\n${RULES}`,
    )

    // 适配器的运行时（pi）原样拿到 instructions，由入口自己拼进系统提示
    await client.call('thread/start', {
      harness: 'pi',
      cwd: '/work/pi',
      developerInstructions: USER,
      dynamicTools: [SESSION_TOOLS],
    })
    const [toPi] = sentTo(env.pi, 'thread/start')
    assert.equal(toPi.developerInstructions, USER)
    assert.equal(toPi.dynamicTools[0].instructions, SESSION_PROPOSAL_RULES)
  } finally {
    await env.close()
  }
})
