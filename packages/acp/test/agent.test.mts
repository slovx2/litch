import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import presets from '../../protocol/src/acp-agents.json' with { type: 'json' }
import { agentId, agentSpec, resolveAgent, splitArgs } from '../src/agent.mjs'
import { versions } from '../src/versions.mjs'
import { FAKE_AGENT, isolate } from './client.mjs'
import { assertResponse } from './schema.mjs'

// 扮演哪个 agent、起什么命令（设计文档 06 第一节的约定），以及命令行用到的 --version、--runtime-info。

const run = promisify(execFile)
const ADAPTER = fileURLToPath(new URL('../src/adapter.mjs', import.meta.url))
const REPO = fileURLToPath(new URL('../../../../../', import.meta.url))

test('参数按空白切开，双引号里的不切，\\" 是字面的引号', () => {
  assert.deepEqual(splitArgs('  --acp   --model x '), ['--acp', '--model', 'x'])
  assert.deepEqual(splitArgs('--name "a b" c'), ['--name', 'a b', 'c'])
  assert.deepEqual(splitArgs('"" x'), ['', 'x'])
  assert.deepEqual(splitArgs('say \\"hi\\"'), ['say', '"hi"'])
  assert.deepEqual(splitArgs('--x="1 2"'), ['--x=1 2'])
  assert.deepEqual(splitArgs(''), [])
})

test('三个标识的预设与环境变量', () => {
  assert.deepEqual(presets, {
    gemini: { command: 'gemini', args: ['--acp'] },
    qwen: { command: 'qwen', args: ['--acp'] },
    acp: { command: '', args: [] },
  })
  assert.equal(agentId({}), 'acp')
  assert.throws(() => agentId({ CHA_ACP_AGENT: 'opencode' }), /只能是/)
  const gemini = agentSpec({ CHA_ACP_AGENT: 'gemini', CHA_GEMINI_HOME: '/tmp/g' })
  assert.equal(gemini.command, 'gemini')
  assert.deepEqual(gemini.args, ['--acp'])
  assert.equal(gemini.home, '/tmp/g')
  assert.deepEqual(gemini.source, { command: 'preset', args: 'preset' })
  const qwen = agentSpec({
    CHA_ACP_AGENT: 'qwen',
    CHA_QWEN_CLI: '/opt/qwen',
    CHA_QWEN_ARGS: '--acp --yolo',
  })
  assert.equal(qwen.command, '/opt/qwen')
  assert.deepEqual(qwen.args, ['--acp', '--yolo'])
  // 设成空串就是不带参数
  assert.deepEqual(agentSpec({ CHA_ACP_AGENT: 'gemini', CHA_GEMINI_ARGS: '' }).args, [])
  // 别的标识的变量不串
  assert.equal(agentSpec({ CHA_ACP_AGENT: 'qwen', CHA_GEMINI_CLI: '/x' }).command, 'qwen')
})

test('找不到命令：报“CLI 不可执行或未找到”（命令行的诊断按这几个字认）', () => {
  assert.throws(() => resolveAgent({ CHA_ACP_AGENT: 'acp' }), /CLI 不可执行或未找到/)
  assert.throws(
    () => resolveAgent({ CHA_ACP_AGENT: 'gemini', PATH: '/nonexistent' }),
    /CLI 不可执行或未找到: gemini/,
  )
  assert.throws(
    () => resolveAgent({ CHA_ACP_AGENT: 'qwen', CHA_QWEN_CLI: '/nonexistent/qwen' }),
    /CLI 不可执行或未找到/,
  )
})

test('ACP 协议版本和 protocol/versions.json 一致', async () => {
  const pinned = JSON.parse(await readFile(join(REPO, 'protocol/versions.json'), 'utf8'))
  assert.equal(versions.acpProtocol, pinned.acpProtocol)
  assert.equal(versions.protocol, pinned.codexProtocol)
  const pkg = JSON.parse(await readFile(join(REPO, 'packages/acp/package.json'), 'utf8'))
  for (const range of Object.values(pkg.dependencies ?? {}))
    assert.match(String(range), /^\d+\.\d+\.\d+$/, '依赖要写精确版本')
})

test('--version 和 --pty-self-check', async () => {
  const { stdout } = await run(process.execPath, [ADAPTER, '--version'], {
    env: { PATH: process.env.PATH, CHA_ACP_AGENT: 'qwen' },
  })
  assert.match(stdout, /codex-harness-adapter-qwen/)
  const pty = await run(process.execPath, [ADAPTER, '--pty-self-check'], {
    env: { PATH: process.env.PATH },
  })
  assert.match(pty.stdout, /pty-self-check ok/)
})

test('--runtime-info：起 agent 只握手，engine 是扮演的标识，声明照 agent 的能力定', async () => {
  const env = await isolate()
  try {
    for (const id of ['gemini', 'qwen', 'acp']) {
      const prefix = `CHA_${id.toUpperCase()}`
      const { stdout } = await run(process.execPath, [ADAPTER, '--runtime-info'], {
        env: {
          ...env.env,
          CHA_ACP_AGENT: id,
          [`${prefix}_CLI`]: process.execPath,
          [`${prefix}_ARGS`]: `"${FAKE_AGENT}"`,
          [`${prefix}_HOME`]: join(env.root, id),
        },
      })
      const info = JSON.parse(stdout)
      assertResponse('runtime/info', info)
      assert.equal(info.engine, id)
      assert.equal(info.protocolVersion, versions.protocol)
      assert.equal(info.cliBuild, '9.9.9')
      assert.equal(info.features.fork, true)
    }
    const methods = (await env.received()).map((m) => m.method).filter(Boolean)
    assert.deepEqual([...new Set(methods)], ['initialize'], '只握手，不建会话、不发提示词')
  } finally {
    await env.restore()
  }
})

test('--runtime-info 的失败：协议版本不符、命令找不到，原因写在标准错误里', async () => {
  const env = await isolate({ FAKE_ACP_VERSION: '2' })
  try {
    await assert.rejects(
      run(process.execPath, [ADAPTER, '--runtime-info'], { env: env.env }),
      (error: any) => error.code === 1 && /ACP 协议版本不符/.test(error.stderr),
    )
    await assert.rejects(
      run(process.execPath, [ADAPTER, '--runtime-info'], {
        env: { PATH: '/usr/bin:/bin', HOME: env.root, CHA_ACP_AGENT: 'gemini' },
      }),
      (error: any) => /CLI 不可执行或未找到/.test(error.stderr),
    )
    await assert.rejects(
      run(process.execPath, [ADAPTER, '--runtime-info'], {
        env: { ...env.env, CHA_ACP_CLI: '/usr/bin/false', CHA_ACP_ARGS: '' },
      }),
      (error: any) => /没有完成 ACP 握手/.test(error.stderr),
    )
  } finally {
    await env.restore()
  }
})
