// 隔离本机服务 + 真实 Codex/Claude + 正式隐藏窗口。模型只访问回环，结束后删除全部夹具。
// 先构建 device、claude、桌面和 UI；CHA_CODEX_CLI / CHA_CLAUDE_CLI 指隔离 CLI。
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { build } from 'esbuild'
import { WebSocket } from 'ws'
import { MockLLM } from '../packages/claude/dist/claude/test/fixtures/mock-llm.mjs'
import { protocolEnv } from '../packages/claude/dist/claude/test/fixtures/protocol-client.mjs'
import {
  MANAGER_DEFAULT_CONTACT,
  MANAGER_DEFAULT_DISPATCH,
} from '../packages/device/dist/protocol/src/manager.mjs'
import { writeDeviceSettings } from './client-fixture-engines.mjs'
import { codexConfig, startResponsesModel, userText } from './client-fixture-responses.mjs'

const repo = fileURLToPath(new URL('..', import.meta.url))
const root = mkdtempSync('/tmp/lrr-local-')
const home = join(root, 'adapter')
const model = new MockLLM()
const gates = []
let heldClaude = 0,
  heldCodex = 0
model.fallback = async (request) => {
  const last = JSON.stringify(request.messages.at(-1))
  if (last.includes('Automatic continuation after a planned service restart'))
    return [{ type: 'text', text: 'CLAUDE_RESTORED' }]
  if (last.includes('RR_HOLD')) {
    heldClaude++
    await new Promise((resolve) => gates.push(resolve))
  }
  return [{ type: 'text', text: 'CLAUDE_DONE' }]
}
const url = await model.start()
const codex = await startResponsesModel((body) => {
  const last = userText(body)
  if (last.startsWith('Give the conversation below a title'))
    return { text: JSON.stringify({ title: '重启验收' }) }
  if (last.includes('Automatic continuation after a planned service restart'))
    return { text: 'CODEX_RESTORED' }
  if (last.includes('RR_HOLD')) {
    heldCodex++
    return { text: 'CODEX_OLD', delay: 60000 }
  }
  return { text: 'CODEX_DONE' }
})
const env = protocolEnv(root, url, false)
mkdirSync(env.CODEX_HOME, { recursive: true })
mkdirSync(env.CLAUDE_CONFIG_DIR, { recursive: true })
writeFileSync(join(env.CODEX_HOME, 'config.toml'), codexConfig(codex.baseUrl))
assert.ok(process.env.CHA_CODEX_CLI, '请指定隔离 Codex CLI')
writeDeviceSettings(home, {
  ...Object.fromEntries(
    ['pi', 'dsh', 'opencode', 'gemini', 'qwen', 'acp', 'agy'].map((h) => [
      `harness.${h}.enabled`,
      false,
    ]),
  ),
  'harness.claude-code.enabled': true,
  'harness.claude-code.cliPath': env.CHA_CLAUDE_CLI,
  'harness.claude-code.env': Object.entries(env)
    .filter(([k]) => /^(ANTHROPIC_|CLAUDE_|DISABLE_)/.test(k) || k === 'CHA_CLAUDE_RUNTIME')
    .map(([name, value]) => ({ name, value })),
  'harness.codex.enabled': true,
  'harness.codex.cliPath': process.env.CHA_CODEX_CLI,
  'harness.codex.env': [{ name: 'CODEX_HOME', value: env.CODEX_HOME }],
  'sessions.wrapUpReminder': false,
})
const binary = join(repo, 'bin/codex-harness-adapter')
const execute = promisify(execFile)
const cli = (cmd, args = []) =>
  execute(binary, [cmd, '--home', home, '--root', repo, '--node', process.execPath, ...args], {
    env,
    timeout: 110000,
  })
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(read, what, ms = 90000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await read()) return
    await delay(100)
  }
  throw Error(`未等到 ${what}`)
}
const clients = new Set()
async function connect() {
  const ws = new WebSocket(`ws+unix://${join(home, 'device/device.sock')}:/`)
  await new Promise((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })
  clients.add(ws)
  let seq = 0
  const pending = new Map(),
    frames = []
  ws.on('message', (bytes) => {
    const f = JSON.parse(bytes.toString())
    frames.push(f)
    const p = pending.get(f.id)
    if (!p || f.method) return
    pending.delete(f.id)
    clearTimeout(p.timer)
    if (f.error) p.reject(Error(JSON.stringify(f.error)))
    else p.resolve(f.result)
  })
  ws.on('close', () => {
    clients.delete(ws)
    for (const p of pending.values()) {
      clearTimeout(p.timer)
      p.reject(Error('closed'))
    }
    pending.clear()
  })
  const call = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++seq,
        timer = setTimeout(() => {
          pending.delete(id)
          reject(Error(`timeout ${method}`))
        }, 30000)
      pending.set(id, { resolve, reject, timer })
      ws.send(JSON.stringify({ id, method, params }))
    })
  await call('initialize', {
    clientInfo: { name: 'restart-local-fixture', version: '1' },
    capabilities: {
      experimentalApi: true,
      litchExtensions: [
        'harness',
        'deviceService',
        'deviceSettings',
        'sessionTree',
        'litchManager',
        'backgroundTasks',
      ],
    },
  })
  ws.send(JSON.stringify({ method: 'initialized' }))
  return { call, frames }
}
let desktop
try {
  const first = JSON.parse((await cli('device-start', ['--ssh=off'])).stdout)
  let c = await connect()
  await until(async () => {
    const r = await c.call('runtime/info')
    return ['codex', 'claude-code'].every((id) =>
      r.harnesses.some((h) => h.id === id && h.available),
    )
  }, '引擎启动')
  const ids = []
  for (const harness of ['codex', 'claude-code']) {
    const { thread } = await c.call('thread/start', {
      harness,
      cwd: root,
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
    })
    ids.push({ id: thread.id, harness, kind: 'top' })
  }
  const { threadId: parent } = await c.call('litch/manager/create', {
    cwd: root,
    harness: 'claude-code',
    model: null,
    effort: null,
    name: '恢复验收经理',
    scope: '隔离恢复',
    rules: '只用回环模型',
    firstTask: '',
    template: 'blank',
    permission: ':danger-full-access',
    dispatch: { ...MANAGER_DEFAULT_DISPATCH, worktree: false },
    contact: { ...MANAGER_DEFAULT_CONTACT, desktopNotification: false },
  })
  await until(async () => {
    const { thread } = await c.call('thread/read', { threadId: parent, includeTurns: true })
    return thread.turns?.at(-1)?.status === 'completed'
  }, '经理开场完成')
  ids.push({ id: parent, harness: 'claude-code', kind: 'manager' })
  for (const { id } of ids)
    await c.call('turn/start', {
      threadId: id,
      input: [{ type: 'text', text: 'RR_HOLD 请继续原任务' }],
    })
  const { threadId: child } = await c.call('litch/session/start', {
    parentThreadId: parent,
    harness: 'codex',
    kind: 'fresh',
    title: '恢复验收子会话',
    prompt: 'RR_HOLD 子会话任务',
    wakeParent: true,
    worktree: false,
  })
  ids.push({ id: child, harness: 'codex', kind: 'child' })
  await until(() => heldClaude === 2 && heldCodex === 2, '四个真实模型回合进入等待')
  console.log('四个回合已运行：', ids)
  if (process.argv.includes('--harness')) {
    for (const harness of ['codex', 'claude-code'])
      await c.call('litch/device/harness/restart', { harness, force: true })
  } else if (process.argv.includes('--protocol')) {
    await cli('device-stop', ['--resume-after-restart'])
    await cli('device-start', ['--ssh=off'])
  } else {
    // 暂存只链接本工作树的构建产物，服务独享临时 HOME；不改共享依赖。
    const stage = join(root, 'stage')
    mkdirSync(join(stage, 'node/bin'), { recursive: true })
    symlinkSync(join(repo, 'packages'), join(stage, 'packages'))
    mkdirSync(join(stage, 'bin'))
    copyFileSync(binary, join(stage, 'bin/codex-harness-adapter'))
    const manifest = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'))
    if (process.argv.includes('--upgrade')) manifest.version = '99.0.0'
    writeFileSync(join(stage, 'package.json'), JSON.stringify(manifest))
    symlinkSync(process.execPath, join(stage, 'node/bin/node'))
    const bootstrap = join(root, 'probe.mjs')
    await build({
      entryPoints: [join(repo, 'apps/desktop/src/probe-restart-resume-local.mts')],
      outfile: bootstrap,
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node24',
      external: ['electron'],
    })
    const require = createRequire(join(repo, 'apps/desktop/package.json'))
    desktop = spawn(require('electron'), [bootstrap], {
      cwd: repo,
      env: {
        ...env,
        LITCH_ADAPTER_ROOT: stage,
        LITCH_ADAPTER_HOME: home,
        LITCH_PROFILE: join(root, 'profile'),
        LITCH_LANG: 'zh-CN',
        LITCH_RESTART_UPGRADE: String(process.argv.includes('--upgrade')),
        LITCH_RESTART_MAIN: join(repo, 'apps/desktop/dist/main.mjs'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    desktop.stdout.on('data', (b) => {
      output += b
      process.stdout.write(b)
    })
    desktop.stderr.on('data', (b) => {
      output += b
    })
    const code = await new Promise((resolve) => desktop.once('exit', resolve))
    assert.equal(code, 0, output.slice(-8000))
  }
  c = await connect()
  const db = new DatabaseSync(join(home, 'device/device.sqlite'), { readOnly: true })
  console.log('恢复票：', db.prepare('SELECT thread_id,state,turn_id FROM restart_turns').all())
  db.close()
  for (const row of ids) {
    await until(async () => {
      const { thread } = await c.call('thread/read', { threadId: row.id, includeTurns: true })
      return thread.turns.some(
        (t) => t.status === 'completed' && JSON.stringify(t).includes('_RESTORED'),
      )
    }, `${row.kind} ${row.harness} 恢复`)
    const { thread } = await c.call('thread/read', { threadId: row.id, includeTurns: true })
    assert.equal(
      thread.turns.filter((t) =>
        JSON.stringify(t).includes('Automatic continuation after a planned service restart'),
      ).length,
      1,
    )
  }
  await until(async () => {
    const { thread } = await c.call('thread/read', { threadId: parent, includeTurns: true })
    return JSON.stringify(thread).includes('CODEX_RESTORED')
  }, '经理收到子会话最终回报')
  const status = JSON.parse((await cli('device-start', ['--ssh=off'])).stdout)
  if (process.argv.includes('--harness')) assert.equal(status.pid, first.pid)
  else assert.notEqual(status.pid, first.pid)
  const finalParent = (await c.call('thread/read', { threadId: parent, includeTurns: true })).thread
  const wakeTurns = finalParent.turns.filter((turn) =>
    turn.items.some(
      (item) => item.type === 'userMessage' && JSON.stringify(item).includes('kind="wake"'),
    ),
  )
  assert.ok(wakeTurns.length <= 1, '同一子会话结果不能反复唤醒经理')
  console.log(
    'PASS：顶层 Codex/Claude、经理、子会话各续一次，父会话收到恢复后的回报；服务进程身份符合重启范围',
  )
} catch (error) {
  console.error(error)
  for (const path of [join(home, 'logs/device.log'), join(root, 'adapter/device.log')]) {
    try {
      console.error(readFileSync(path, 'utf8').slice(-10000))
    } catch {}
  }
  process.exitCode = 1
} finally {
  desktop?.kill()
  for (const ws of clients) ws.close()
  for (const release of gates) release()
  await cli('device-stop').catch((error) => console.error('收尾停止失败', error))
  codex.close()
  await model.close()
  rmSync(root, { recursive: true, force: true })
}

process.exit(process.exitCode ?? 0)
