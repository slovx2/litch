// 在已经启动、安装本分支包的专用模拟器上跑模拟核心流程；不连接真实设备或模型。
// node scripts/check-tablet.mjs <emulator-端口|Litch-iOS-模拟器UDID> tablet/navigation.yaml ...
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { withConsentSteps } from './consent-flows.mjs'

const mobile = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const [device, ...flows] = process.argv.slice(2)
if (!device || !flows.length) throw new Error('需要模拟器标识和至少一条流程')
const ios = /^[0-9A-F-]{36}$/.test(device)
const adb = process.env.ADB ?? 'adb'
if (ios) {
  const devices = JSON.parse(
    execFileSync('xcrun', ['simctl', 'list', 'devices', '--json'], { encoding: 'utf8' }),
  )
  const found = Object.values(devices.devices)
    .flat()
    .find((entry) => entry.udid === device)
  if (!found?.name.startsWith('Litch-iOS-') || found.state !== 'Booted')
    throw new Error('仅允许已启动的 Litch-iOS- 专用模拟器')
} else {
  if (!/^emulator-\d+$/.test(device)) throw new Error('仅允许 Android 模拟器')
  const name = execFileSync(adb, ['-s', device, 'emu', 'avd', 'name'], { encoding: 'utf8' })
    .split('\n')[0]
    .trim()
  if (!name.startsWith('litch_')) throw new Error('仅允许 litch_ 专用 AVD')
}
for (const flow of flows) {
  if (!/^(tablet|flows\/mock)\/[\w-]+\.yaml$/.test(flow)) throw new Error(`无效流程：${flow}`)
}
const artifacts = mkdtempSync(join(tmpdir(), 'litch-tablet-maestro-'))
let locked = false
let child
let stopped = false
const confirm = (indent = '') =>
  `${indent}- runFlow:\n${indent}    when:\n${indent}      visible: '.*(在.*Litch.*中打开|Open in.*Litch).*'\n${indent}    commands:\n${indent}      - tapOn: '^(打开|Open)$'`
function copy(from, to) {
  mkdirSync(to, { recursive: true })
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const source = join(from, entry.name)
    const target = join(to, entry.name)
    if (entry.isDirectory()) copy(source, target)
    else if (/\.(yaml|js)$/.test(entry.name)) {
      let text = readFileSync(source, 'utf8')
        .replaceAll('${WIDE_ORIENTATION}', ios ? 'LANDSCAPE_LEFT' : 'PORTRAIT')
        .replaceAll('${TALL_ORIENTATION}', ios ? 'PORTRAIT' : 'LANDSCAPE_LEFT')
      if (ios)
        text = text
          .replace(/dev\.litch\.app(?!\.dev)/g, 'dev.litch.app.dev')
          .replaceAll('litch://', 'litch-dev://')
          .replace(/^( *)- openLink: (.+)$/gm, (line, indent) => `${line}\n${confirm(indent)}`)
          .replace(
            /^( *)- hideKeyboard[ \t]*$/gm,
            (_, indent) =>
              `${indent}- tapOn:\n${indent}    id: keyboard:done\n${indent}- extendedWaitUntil:\n${indent}    notVisible:\n${indent}      id: keyboard:done\n${indent}    timeout: 5000`,
          )
          .replace(
            /^( *)- back$/gm,
            (_, indent) => `${indent}- tapOn:\n${indent}    id: header:back`,
          )
      writeFileSync(target, withConsentSteps(text, source))
    }
  }
}
function cleanup() {
  if (locked) {
    // 此目录只在本进程成功 mkdir 后删除，不动其他验收线的锁。
    rmSync('/tmp/litch-maestro-7001.lock/owner', { force: true })
    rmSync('/tmp/litch-maestro-7001.lock', { recursive: true })
    locked = false
  }
  rmSync(artifacts, { recursive: true, force: true })
}
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    stopped = true
    child?.kill('SIGTERM')
  })
try {
  copy(join(mobile, 'e2e'), join(artifacts, 'e2e'))
  while (!locked && !stopped) {
    try {
      mkdirSync('/tmp/litch-maestro-7001.lock')
      locked = true
      writeFileSync(
        '/tmp/litch-maestro-7001.lock/owner',
        `mobile-tablet PID=${process.pid} started=${new Date().toISOString()}\n`,
      )
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      console.log('等待 Maestro 共享锁')
      await sleep(10_000)
    }
  }
  for (const flow of flows) {
    if (stopped) break
    console.log(`开始 ${device} ${flow}`)
    child = spawn(
      process.env.MAESTRO ?? 'maestro',
      [
        '--udid',
        device,
        'test',
        '--no-ansi',
        '--test-output-dir',
        artifacts,
        '--debug-output',
        artifacts,
        '-e',
        `APP_ID=${ios ? 'dev.litch.app.dev' : 'dev.litch.app'}`,
        '-e',
        `SCHEME=${ios ? 'litch-dev' : 'litch'}`,
        '-e',
        `SCREENSHOTS=${process.env.LITCH_TABLET_SCREENSHOTS ?? artifacts}`,
        '-e',
        `WIDE_ORIENTATION=${ios ? 'LANDSCAPE_LEFT' : 'PORTRAIT'}`,
        '-e',
        `TALL_ORIENTATION=${ios ? 'PORTRAIT' : 'LANDSCAPE_LEFT'}`,
        join(artifacts, 'e2e', flow),
      ],
      {
        stdio: 'inherit',
        env: { ...process.env, JAVA_TOOL_OPTIONS: '-Djava.net.preferIPv4Stack=true' },
      },
    )
    const deadline = setTimeout(() => child.kill('SIGTERM'), 8 * 60_000)
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', resolve)
    }).finally(() => clearTimeout(deadline))
    console.log(`结果 ${flow}: ${code === 0 ? 'PASS' : 'FAIL'}`)
    if (code !== 0) {
      process.exitCode = code ?? 1
      break
    }
  }
  if (stopped) process.exitCode = 130
} finally {
  cleanup()
}
