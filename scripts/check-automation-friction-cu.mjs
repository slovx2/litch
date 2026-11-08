// 自有 AppKit 测试窗口 → 正式执行器 → 签名探针 → AXPress；不操作用户应用。
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

registerHooks({
  resolve(specifier, context, next) {
    try {
      return next(specifier, context)
    } catch (error) {
      if (!specifier.endsWith('.mjs')) throw error
      return next(specifier.replace(/\.mjs$/, '.mts'), context)
    }
  },
})
const { createComputerExecutor } = await import('../apps/desktop/src/computer-use/executor.mts')
const { MacLauncher } = await import(
  '../third_party/litch-automation/packages/computer-use/src/launcher-mac.mts'
)
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const appPath = join(
  root,
  'apps/computer-use/.artifacts/integration/Litch Background Input Probe.app',
)
const work = mkdtempSync('/tmp/litch-cu-friction-')
const out = join(root, '.local/automation-friction-cu')
mkdirSync(out, { recursive: true })
mkdirSync(join(work, 'home'))
const launcher = new MacLauncher({
  identity: {
    helperId: 'io.github.slovx2.litch.background-input-probe',
    helperName: 'Litch Background Input Probe',
    executableName: 'Probe',
    directoryEnv: 'LITCH_COMPUTER_USE_DIR',
    tokenEnv: 'LITCH_COMPUTER_USE_TOKEN',
  },
  appPath,
  directory: join(work, 'helper'),
  version: null,
  async launch(path, env) {
    execFileSync('open', [
      '-n',
      '-g',
      ...Object.entries({
        ...env,
        HOME: join(work, 'home'),
        CODEX_HOME: join(work, 'codex'),
      }).flatMap(([k, v]) => ['--env', `${k}=${v}`]),
      path,
    ])
  },
})
const client = await launcher.establish('zh-CN', () => {})
let pid
const report = { permissions: null, calls: [], clicks: null }
try {
  report.permissions = await client.request('permissions')
  assert.equal(report.permissions.accessibility, true, '测试探针缺少辅助功能权限')
  assert.equal(report.permissions.screenRecording, true, '测试探针缺少屏幕录制权限')
  const app = 'io.github.slovx2.litch.automation-friction-fixture'
  const bundle = join(out, 'Friction Fixture.app')
  mkdirSync(join(bundle, 'Contents/MacOS'), { recursive: true })
  writeFileSync(
    join(bundle, 'Contents/Info.plist'),
    `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${app}</string>
<key>CFBundleExecutable</key><string>Fixture</string><key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleName</key><string>Friction Fixture</string><key>LSUIElement</key><true/></dict></plist>`,
  )
  execFileSync(
    'swiftc',
    [
      join(root, 'apps/computer-use/probes/background/Fixture.swift'),
      '-o',
      join(bundle, 'Contents/MacOS/Fixture'),
      '-framework',
      'AppKit',
    ],
    { stdio: 'inherit' },
  )
  execFileSync('codesign', ['--force', '--sign', '-', bundle])
  const directory = join(work, 'fixture')
  execFileSync('open', [
    '-n',
    '-g',
    bundle,
    '--args',
    '--directory',
    directory,
    '--role',
    'friction',
  ])
  const state = () => JSON.parse(readFileSync(join(directory, 'state.json'), 'utf8'))
  for (let i = 0; i < 100; i++) {
    try {
      pid = state().pid
      break
    } catch {
      await delay(100)
    }
  }
  assert.ok(pid, '测试窗口未就绪')
  const helper = { client: async () => client, connected: client, restart: async () => {} }
  const executor = createComputerExecutor({ helper })
  let seq = 0
  const call = async (tool, args) => {
    const result = await executor.call(
      {
        id: `friction-${++seq}`,
        callId: String(seq),
        device: { id: 'fixture' },
        threadId: 'friction',
        turnId: 'friction',
        namespace: 'litch_computer',
        tool,
        arguments: args,
      },
      { signal: new AbortController().signal, ask: async () => null },
    )
    const text = result.contentItems
      .filter((i) => i.type === 'inputText')
      .map((i) => i.text)
      .join('\n')
    report.calls.push({ tool, success: result.success, chars: text.length })
    writeFileSync(join(out, `result-${seq}.json`), JSON.stringify(result, null, 2))
    assert.equal(result.success, true, text)
    return text
  }
  assert.match(await call('list_apps', {}), /Friction Fixture/)
  const before = await call('get_app_state', { app })
  const element = Number(
    before
      .split('\n')
      .find((l) => /Button.*计数按钮/.test(l))
      ?.match(/\[(\d+)\]/)?.[1],
  )
  assert.ok(element, before)
  const batch = await call('run_actions', {
    actions: [
      { tool: 'click', arguments: { app, element } },
      { tool: 'click', arguments: { app, element } },
    ],
  })
  assert.match(batch, /Batch completed/)
  await delay(300)
  report.clicks = state().clicks
  assert.equal(report.clicks, 2, '必须真实增加两次计数，派发成功不等于业务成功')
  await executor.turnEnded({ deviceId: 'fixture', threadId: 'friction', turnId: 'friction' })
  console.log(JSON.stringify(report))
} finally {
  try {
    report.clicks = JSON.parse(readFileSync(join(work, 'fixture/state.json'), 'utf8')).clicks
  } catch {}
  if (pid) {
    try {
      process.kill(pid, 'SIGTERM')
    } catch {}
  }
  await client.request('shutdown').catch(() => {})
  client.close()
  writeFileSync(join(out, 'report.json'), JSON.stringify({ ...report, work }, null, 2))
}
