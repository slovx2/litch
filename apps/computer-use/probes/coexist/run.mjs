// 只启动本次夹具，Electron 始终隐藏；finally 退出自有进程并删除全部运行证据。
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { withChromiumTestArgs } from '../../../../third_party/litch-automation/scripts/chromium-test-args.mjs'
import { probeAppPath } from '../integration/shared-probe.mjs'
import { hidIdleSeconds } from './idle.mjs'

const idle = hidIdleSeconds()
if (idle < 60) {
  console.log(JSON.stringify([{ discarded: true, reason: 'HIDIdleTime < 60s', idle }]))
  process.exit(75)
}

const source = fileURLToPath(new URL('../background/', import.meta.url))
const cu = resolve(source, '../..')
const root = mkdtempSync('/tmp/litch-cu-coexist-')
const read = (name) => JSON.parse(readFileSync(join(root, name, 'state.json'), 'utf8'))
const env = { ...process.env, HOME: join(root, 'home'), CODEX_HOME: join(root, 'codex') }
delete env.ELECTRON_RUN_AS_NODE
for (const name of ['home', 'codex', 'appkit', 'guard', 'electron'])
  mkdirSync(join(root, name), { recursive: true })
const children = []
let cancelled = false
process.on('SIGTERM', () => {
  cancelled = true
})
process.on('SIGINT', () => {
  cancelled = true
})
async function until(fn) {
  for (let i = 0; i < 600; i++) {
    if (cancelled) throw new Error('验收已取消')
    try {
      const value = fn()
      if (value) return value
    } catch {}
    await delay(50)
  }
  throw new Error('等待本轮探针超时')
}
function open(path, extra = {}, args = []) {
  execFileSync('open', [
    '-n',
    '-g',
    ...Object.entries({ HOME: env.HOME, CODEX_HOME: env.CODEX_HOME, ...extra }).flatMap(
      ([k, v]) => ['--env', `${k}=${v}`],
    ),
    path,
    '--args',
    ...args,
  ])
}
try {
  for (const [name, title] of [
    ['appkit', 'Fixture'],
    ['guard', 'Guard'],
  ]) {
    open(join(cu, '.artifacts/background', `Litch Background ${title}.app`), {}, [
      '--directory',
      join(root, name),
      '--role',
      name === 'guard' ? 'guard' : 'target',
    ])
    const state = await until(() => read(name))
    children.push(state.pid)
  }
  const electron = spawn(
    join(cu, '../desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),
    withChromiumTestArgs([join(source, 'electron.cjs'), '--directory', join(root, 'electron')]),
    { env: { ...env, LITCH_PROBE_HIDDEN: '1' }, stdio: 'ignore' },
  )
  children.push(electron.pid)
  await until(() => read('electron'))
  const beforeProbeIdle = hidIdleSeconds()
  if (beforeProbeIdle < 60) {
    console.log(
      JSON.stringify([
        { discarded: true, reason: 'HID input during fixture setup', idle: beforeProbeIdle },
      ]),
    )
    process.exitCode = 75
  } else {
    open(probeAppPath(), {
      LITCH_CU_COEXIST_DIR: root,
      LITCH_CU_PEEKABOO: process.env.LITCH_CU_PEEKABOO ?? '',
      LITCH_CU_GROUP: process.env.LITCH_CU_GROUP ?? 'coexist',
    })
    children.push(await until(() => Number(readFileSync(join(root, 'probe.pid'), 'utf8'))))
    const result = await until(() => JSON.parse(readFileSync(join(root, 'result.json'), 'utf8')))
    console.log(JSON.stringify(result, null, 2))
    if (result.some((r) => r.discarded)) process.exitCode = 75
    else if (result.some((r) => r.error || r.passed === false)) process.exitCode = 1
  }
} finally {
  for (const name of ['appkit', 'guard', 'electron']) {
    writeFileSync(
      join(root, name, 'command.json'),
      JSON.stringify({ id: 'cleanup', action: 'quit' }),
    )
  }
  await delay(300)
  for (const pid of children) {
    try {
      process.kill(pid, 'SIGTERM')
    } catch {}
  }
  rmSync(root, { recursive: true, force: true })
}
