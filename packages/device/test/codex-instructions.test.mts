// 原生 codex 的开发者指令由设备进程补齐（codex-instructions.mts）：建会话时客户端没给就拿 config.toml 里实际生效的那段当底子，
// 按会话记下，恢复、分叉没带时照记下的补回去，规则按这一版的重拼；分叉的分叉接得上；设备进程自己的连接也一样。
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { SESSION_PROPOSAL_RULES, SESSION_TOOLS } from '../../protocol/src/client-tools-sessions.mjs'
import { ECHO_TOOLS } from '../../protocol/src/client-tools-specs.mjs'
import { composeInstructions } from '../src/codex-instructions.mjs'
import { openSessionDatabase, SessionStore } from '../src/session-store.mjs'
import { codexRig, sentTo } from './codex-kit.mjs'
import { codexThread } from './fake-codex.mjs'

const USER = 'User developer instructions.'
const CONFIG = 'From config.toml.'
const PROJECT = 'From the project config.'
const OLD_ONE = codexThread(1, 400).id
const OLD_TWO = codexThread(2, 200).id
const RULES = `# Tool instructions: litch_sessions\n${SESSION_PROPOSAL_RULES}`

/** 假 codex 的 config/read：/work/proj 下有项目层的 developer_instructions，别处是用户层的 */
function withConfig(env: ReturnType<typeof codexRig>, user: string | null = CONFIG) {
  env.codex.handlers['config/read'] = (params: any) => ({
    config: {
      ...(params.cwd === '/work/proj'
        ? { developer_instructions: PROJECT }
        : user === null
          ? {}
          : { developer_instructions: user }),
    },
    origins: {},
  })
}

async function litch(env: ReturnType<typeof codexRig>) {
  const client = env.connect()
  await client.initialize(['harness', 'clientTools'], {
    litchClientTools: { namespaces: ['litch_echo'] },
  })
  return client
}

const last = (env: ReturnType<typeof codexRig>, method: string) => sentTo(env.codex, method).at(-1)

test('CODEX-DEV-001：建会话时客户端没给开发者指令：底子是 config.toml 里实际生效的那段（带 cwd，项目层算进去），规则拼在后面，按会话记下', async () => {
  const env = codexRig()
  try {
    withConfig(env)
    const client = await litch(env)
    const started = await client.call('thread/start', {
      harness: 'codex',
      cwd: '/work/proj',
      dynamicTools: [ECHO_TOOLS, SESSION_TOOLS],
    })
    assert.deepEqual(last(env, 'config/read'), { cwd: '/work/proj' })
    const seen = last(env, 'thread/start')
    assert.equal(seen.developerInstructions, `${PROJECT}\n\n${RULES}`)
    assert.equal(
      seen.dynamicTools.some((spec: any) => 'instructions' in spec),
      false,
    )
    assert.deepEqual(env.device.sessionTree.store.instructions(started.thread.id), {
      given: null,
      namespaces: [{ name: 'litch_sessions', instructions: SESSION_PROPOSAL_RULES }],
      cwd: '/work/proj',
    })
    // 客户端给了：不问 config.toml，记下客户端那段
    const asked = sentTo(env.codex, 'config/read').length
    const given = await client.call('thread/start', {
      harness: 'codex',
      cwd: '/work/other',
      developerInstructions: USER,
      dynamicTools: [SESSION_TOOLS],
    })
    assert.equal(sentTo(env.codex, 'config/read').length, asked)
    assert.equal(last(env, 'thread/start').developerInstructions, `${USER}\n\n${RULES}`)
    assert.equal(env.device.sessionTree.store.instructions(given.thread.id)?.given, USER)
    // 没有规则的会话：什么都不补、不问、不记
    const plain = await client.call('thread/start', {
      harness: 'codex',
      cwd: '/work/other',
      dynamicTools: [ECHO_TOOLS],
    })
    assert.equal('developerInstructions' in last(env, 'thread/start'), false)
    assert.equal(sentTo(env.codex, 'config/read').length, asked)
    assert.equal(env.device.sessionTree.store.instructions(plain.thread.id), null)
    // config.toml 里没配：只有规则
    withConfig(env, null)
    await client.call('thread/start', {
      harness: 'codex',
      cwd: '/work/other',
      dynamicTools: [SESSION_TOOLS],
    })
    assert.equal(last(env, 'thread/start').developerInstructions, RULES)
  } finally {
    await env.close()
  }
})

test('CODEX-DEV-002：恢复没带开发者指令：底子是记下的客户端那段，没有就重新问 config.toml；带了但没有规则的拼上规则，有了的原样', async () => {
  const env = codexRig()
  try {
    withConfig(env)
    const client = await litch(env)
    const bare = (
      await client.call('thread/start', {
        harness: 'codex',
        cwd: '/work/proj',
        dynamicTools: [SESSION_TOOLS],
      })
    ).thread.id
    const own = (
      await client.call('thread/start', {
        harness: 'codex',
        cwd: '/work/a',
        developerInstructions: USER,
        dynamicTools: [SESSION_TOOLS],
      })
    ).thread.id
    // 官方桌面端那样的连接：恢复只带会话号
    const desktop = env.connect()
    await desktop.initialize(['harness'])
    await desktop.call('thread/resume', { threadId: bare })
    assert.deepEqual(last(env, 'config/read'), { cwd: '/work/proj' })
    assert.equal(last(env, 'thread/resume').developerInstructions, `${PROJECT}\n\n${RULES}`)
    await desktop.call('thread/resume', { threadId: own })
    assert.equal(last(env, 'thread/resume').developerInstructions, `${USER}\n\n${RULES}`)
    // 客户端带了自己的、没有规则：拼上；已经有规则的原样
    await client.call('thread/resume', { threadId: own, developerInstructions: 'Newer.' })
    assert.equal(last(env, 'thread/resume').developerInstructions, `Newer.\n\n${RULES}`)
    await client.call('thread/resume', {
      threadId: own,
      developerInstructions: `Newer.\n\n${RULES}`,
    })
    assert.equal(last(env, 'thread/resume').developerInstructions, `Newer.\n\n${RULES}`)
    // 客户端带过的那段记下来了：以后不带时照它
    await desktop.call('thread/resume', { threadId: own })
    assert.equal(last(env, 'thread/resume').developerInstructions, `Newer.\n\n${RULES}`)
    // 不是经设备进程建的、没有规则的会话：原样
    await desktop.call('thread/resume', { threadId: OLD_ONE })
    assert.equal('developerInstructions' in last(env, 'thread/resume'), false)
  } finally {
    await env.close()
  }
})

test('CODEX-DEV-003：规则按这一版的重拼；更早的设备进程只记了动态工具的会话也补；config/read 失败时只放规则', async () => {
  const env = codexRig()
  try {
    const client = await litch(env)
    const { store } = env.device.sessionTree
    store.setInstructions(OLD_ONE, {
      given: USER,
      namespaces: [{ name: 'litch_sessions', instructions: 'Old rules.' }],
      cwd: '/work',
    })
    await client.call('thread/resume', { threadId: OLD_ONE })
    assert.equal(last(env, 'thread/resume').developerInstructions, `${USER}\n\n${RULES}`)
    // 只记了动态工具的（上一版设备进程建的）；假 codex 没有 config/read：只放规则，记一行日志
    store.setTools(OLD_TWO, [ECHO_TOOLS, SESSION_TOOLS])
    await client.call('thread/resume', { threadId: OLD_TWO })
    assert.equal(last(env, 'thread/resume').developerInstructions, RULES)
    assert.ok(env.logs.some((line) => line.includes('config/read 没成')))
  } finally {
    await env.close()
  }
})

test('CODEX-DEV-004：分叉没带：照源会话补，并用新会话号记一份，分叉的分叉也接得上；设备进程自己的连接一样', async () => {
  const env = codexRig()
  try {
    withConfig(env)
    const client = await litch(env)
    const source = (
      await client.call('thread/start', {
        harness: 'codex',
        cwd: '/work/a',
        developerInstructions: USER,
        dynamicTools: [SESSION_TOOLS],
      })
    ).thread.id
    const fork = (await client.call('thread/fork', { threadId: source })).thread.id
    assert.equal(last(env, 'thread/fork').developerInstructions, `${USER}\n\n${RULES}`)
    assert.equal(env.device.sessionTree.store.instructions(fork)?.given, USER)
    // 设备进程自己的连接（派 fork 子会话、定时任务走的那条）分叉这个分叉
    const link = await env.device.openEngineLink('codex')
    try {
      const again = await link.request('thread/fork', { threadId: fork })
      assert.equal(last(env, 'thread/fork').developerInstructions, `${USER}\n\n${RULES}`)
      const id = again.thread.id as string
      assert.deepEqual(env.device.sessionTree.store.instructions(id)?.namespaces, [
        { name: 'litch_sessions', instructions: SESSION_PROPOSAL_RULES },
      ])
      await link.request('thread/resume', { threadId: id })
      assert.equal(last(env, 'thread/resume').developerInstructions, `${USER}\n\n${RULES}`)
    } finally {
      link.close()
    }
  } finally {
    await env.close()
  }
})

test('CODEX-DEV-005：记下的存在 sessions.sqlite 里，设备进程重启后还在；拼法：底子在前，规则底子里已经有的不再拼', () => {
  const dir = mkdtempSync(join(tmpdir(), 'litch-cdi-'))
  const record = {
    given: null,
    namespaces: [{ name: 'litch_sessions', instructions: 'Rules.' }],
    cwd: '/w',
  }
  const first = openSessionDatabase(dir)
  new SessionStore(first).setInstructions('t1', record)
  first.close()
  const second = openSessionDatabase(dir)
  assert.deepEqual(new SessionStore(second).instructions('t1'), record)
  assert.equal(new SessionStore(second).instructions('t2'), null)
  second.close()
  assert.equal(composeInstructions(null, []), null)
  assert.equal(composeInstructions('  ', ['# A']), '# A')
  assert.equal(composeInstructions('Mine\n', ['# A', '# B']), 'Mine\n\n# A\n\n# B')
  assert.equal(composeInstructions('Mine\n\n# A', ['# A', '# B']), 'Mine\n\n# A\n\n# B')
})
