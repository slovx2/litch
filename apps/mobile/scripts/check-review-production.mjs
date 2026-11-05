// 在专用模拟器上验发布包；种入旧开发配置模拟升级，不使用开发深链准备状态。
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { auditIOSReview } from './audit-ios-review.mjs'

const mobile = resolve(fileURLToPath(new URL('..', import.meta.url)))
const [simulator, app] = process.argv.slice(2)
const simctl = (...args) => execFileSync('xcrun', ['simctl', ...args], { encoding: 'utf8' })
const devices = JSON.parse(simctl('list', 'devices', '--json'))
const device = Object.values(devices.devices)
  .flat()
  .find((entry) => entry.udid === simulator)
assert.ok(device?.name.startsWith('Litch-iOS-Review'), '只能操作审核验收专用模拟器')
assert.ok(app?.startsWith('/'), '必须给发布 .app 绝对路径')
const audit = auditIOSReview(app)
assert.equal(audit.bundleId, 'dev.litch.app')
const lock = '/tmp/litch-maestro-7001.lock'
const artifacts = join(mobile, '.artifacts/review-production')
mkdirSync(artifacts, { recursive: true })
let locked = false
let child
let interrupted = false
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    interrupted = true
    child?.kill(signal)
  })
try {
  while (!locked) {
    if (interrupted) throw new Error('验收已中止')
    try {
      mkdirSync(lock)
      locked = true
      writeFileSync(join(lock, 'owner'), JSON.stringify({ pid: process.pid, simulator }))
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      console.log('等待 Maestro 7001 共享锁')
      await sleep(30000)
    }
  }
  simctl('install', simulator, app)
  const container = simctl('get_app_container', simulator, 'dev.litch.app', 'data').trim()
  const documents = join(container, 'Documents')
  mkdirSync(documents, { recursive: true })
  writeFileSync(join(documents, 'prefs.json'), JSON.stringify({ boot: 'fixture', lang: 'en' }))
  writeFileSync(join(documents, 'remote-dev.json'), JSON.stringify({ adapter: 'review-fixture' }))
  writeFileSync(
    join(documents, 'update-feed.json'),
    JSON.stringify({ feed: 'https://example.invalid/feed' }),
  )
  if (interrupted) throw new Error('验收已中止')
  child = spawn(
    process.env.MAESTRO ?? 'maestro',
    [
      '--device',
      simulator,
      'test',
      '--no-ansi',
      '--debug-output',
      artifacts,
      '--format',
      'JUNIT',
      '--output',
      join(artifacts, 'junit.xml'),
      join(mobile, 'e2e/flows/production/review-links.yaml'),
    ],
    { stdio: 'inherit', env: { ...process.env, MAESTRO_CLI_NO_ANALYTICS: '1' } },
  )
  const deadline = setTimeout(() => child.kill('SIGTERM'), 10 * 60_000)
  const code = await new Promise((done, fail) => {
    child.on('error', fail)
    child.on('exit', done)
  }).finally(() => clearTimeout(deadline))
  assert.equal(code, 0, '发布包 Maestro 负测失败')
  assert.equal(JSON.parse(readFileSync(join(documents, 'prefs.json'), 'utf8')).boot, 'stored')
  assert.equal(existsSync(join(documents, 'remote-dev.json')), false)
  assert.equal(existsSync(join(documents, 'update-feed.json')), false)
  writeFileSync(
    join(artifacts, 'audit.json'),
    JSON.stringify({ ...audit, legacyConfigCleared: true }, null, 2),
  )
  console.log('发布包负测与旧开发配置清理通过')
} finally {
  if (locked) {
    unlinkSync(join(lock, 'owner'))
    rmdirSync(lock)
  }
  simctl('shutdown', simulator)
}
