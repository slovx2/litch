// 在已安装开发包的专用 iOS 模拟器上复用 Android 的产品断言；不碰用户真机。
// 用法：node scripts/check-ios.mjs <simulator-udid> <fixture.json> mock/01-home.yaml ...
// 保留产品断言，替换开发包与深链，并处理 iOS 首次打开深链的系统确认。临时报告退出时删除。
import { execFileSync, spawn } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { iosTestHelper } from './ios-test-helper.mjs'
import { installTerminalAudit } from './terminal-audit.mjs'

const mobile = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const [simulator, configPath, ...flows] = process.argv.slice(2)
if (!simulator || !configPath || !flows.length)
  throw new Error('需要专用模拟器 UDID、夹具配置和流程列表')
const devices = JSON.parse(
  execFileSync('xcrun', ['simctl', 'list', 'devices', '--json'], { encoding: 'utf8' }),
)
const device = Object.values(devices.devices)
  .flat()
  .find((entry) => entry.udid === simulator)
if (!device?.name.startsWith('Litch-iOS-')) throw new Error('仅允许 Litch-iOS- 命名的隔离模拟器')
const config = JSON.parse(readFileSync(configPath, 'utf8'))
const base = join(mobile, '.artifacts')
mkdirSync(base, { recursive: true })
const artifacts = mkdtempSync(join(base, 'ios-validation-'))
const helper = await iosTestHelper(config, artifacts)
let child
let stopping = false
let locked = false
const cleanup = async () => {
  if (stopping) return
  stopping = true
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = new Promise((resolve) => child.once('exit', resolve))
    child.kill('SIGTERM')
    await exited
  }
  try {
    await helper.stop()
    rmSync(artifacts, { recursive: true })
  } finally {
    if (locked) {
      if (existsSync('/tmp/litch-maestro-7001.lock/owner'))
        unlinkSync('/tmp/litch-maestro-7001.lock/owner')
      rmdirSync('/tmp/litch-maestro-7001.lock')
      locked = false
    }
  }
}
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    void cleanup().then(() => process.exit(130))
  })

try {
  const confirmLink = (indent = '') =>
    `${indent}- runFlow:\n${indent}    when:\n${indent}      visible: '.*(在.*Litch Dev.*中打开|Open in.*Litch Dev).*'\n${indent}    commands:\n${indent}      - tapOn: '^(打开|Open)$'`
  const copy = (source, target) => {
    mkdirSync(target, { recursive: true })
    for (const entry of readdirSync(source, { withFileTypes: true })) {
      const from = join(source, entry.name)
      const to = join(target, entry.name)
      if (entry.isDirectory()) copy(from, to)
      else
        writeFileSync(
          to,
          readFileSync(from, 'utf8')
            .replace(/dev\.litch\.app(?!\.dev)/g, 'dev.litch.app.dev')
            .replaceAll('litch://', 'litch-dev://')
            .replace('    stopApp: true\n', () => `    stopApp: true\n${confirmLink()}\n`)
            .replace(
              /^( *)- openLink: (.+)$/gm,
              (line, indent) => `${line}\n${confirmLink(indent)}`,
            ),
        )
    }
  }
  copy(join(mobile, 'e2e/flows'), join(artifacts, 'flows'))
  copy(join(mobile, 'e2e/ios'), join(artifacts, 'flows/ios'))
  const git = (...args) =>
    execFileSync('git', ['-c', 'user.name=e2e', '-c', 'user.email=e2e@localhost', ...args], {
      cwd: config.work,
      stdio: 'ignore',
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
    })
  if (!existsSync(join(config.work, '.git'))) {
    writeFileSync(join(config.work, 'README.md'), '# e2e\n\n第一行\n第二行\n')
    git('init', '-q', '-b', 'main')
    git('add', '.')
    git('commit', '-q', '-m', 'init')
    writeFileSync(join(config.work, 'README.md'), '# e2e\n\n第一行\n改过的第二行\n')
    writeFileSync(join(config.work, 'notes.txt'), 'e2e 新加的文件\n')
  }
  installTerminalAudit(config)
  const env = {
    ADAPTER: config.adapter,
    FX_MODE: 'svc',
    FIXTURE_PORT: String(config.target.port),
    FIXTURE_USER: config.target.user,
    PORT: String(config.target.port),
    USER: config.target.user,
    KEY: config.target.privateKey,
    FINGERPRINT_RE: config.target.hostFingerprint.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
    WORK: config.work,
    HELPER: helper.url,
    HELPER_PORT: new URL(helper.url).port,
  }
  const args = [
    '--udid',
    simulator,
    'test',
    '--no-ansi',
    '--test-output-dir',
    artifacts,
    '--debug-output',
    artifacts,
  ]
  for (const [key, value] of Object.entries(env)) args.push('-e', `${key}=${value}`)
  while (!locked) {
    try {
      mkdirSync('/tmp/litch-maestro-7001.lock')
      locked = true
      writeFileSync(
        '/tmp/litch-maestro-7001.lock/owner',
        `mobile-ios PID=${process.pid} started=${new Date().toISOString()}\n`,
      )
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      console.log('等待其他手机线释放 Maestro 7001；30 秒后重试。')
      await sleep(30_000)
    }
  }
  for (const flow of flows) {
    if (stopping) break
    if (!/^(mock|fixture|ios)\/[\w-]+\.yaml$/.test(flow)) throw new Error(`无效流程：${flow}`)
    console.log(`iOS 验收开始：${flow}`)
    child = spawn(process.env.MAESTRO ?? 'maestro', [...args, join(artifacts, 'flows', flow)], {
      stdio: 'inherit',
    })
    const code = await new Promise((resolve, reject) => {
      child.on('error', reject)
      child.on('exit', resolve)
    })
    console.log(`iOS 验收结果：${flow} ${code === 0 ? '通过' : '失败'}`)
    if (code !== 0) process.exitCode = code ?? 1
  }
} finally {
  await cleanup()
}
