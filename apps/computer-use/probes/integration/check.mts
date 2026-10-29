// 经真实本机 IPC 验产品动作；只操作本轮自有夹具，不调用会话 Computer Use 工具。
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { HelperClient } from '../../../desktop/src/computer-use/helper-client.mjs'
import { MacLauncher } from '../../../desktop/src/computer-use/launcher-mac.mjs'

const fixture = process.argv[2],
  directory = process.argv[3],
  appPath = process.argv[4]
if (
  !fixture?.startsWith('/tmp/litch-cu-') ||
  !directory?.startsWith('/tmp/litch-cu-') ||
  !appPath?.includes('/.artifacts/integration/')
)
  throw new Error('只接受隔离验收路径')
mkdirSync(directory, { recursive: true, mode: 0o700 })
const read = (path: string): any => JSON.parse(readFileSync(path, 'utf8'))
const write = (path: string, value: unknown) => {
  writeFileSync(`${path}.tmp`, JSON.stringify(value))
  renameSync(`${path}.tmp`, path)
}
let checkUserIdle = () => {}
async function until<T>(read: () => T | undefined | false, timeout = 8000): Promise<T> {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    try {
      const value = read()
      if (value) return value
    } catch {}
    await delay(50)
  }
  throw new Error('等待验收条件超时')
}
async function command(name: string, action: string) {
  checkUserIdle()
  const id = randomUUID()
  write(join(fixture, name, 'command.json'), { id, action })
  await until(() => read(join(fixture, name, 'state.json')).commandID === id)
  await delay(100)
}
const state = (name: string) => read(join(fixture, name, 'state.json'))
const targets = {
  appkit: 'io.github.slovx2.litch.background-fixture',
  electron: 'com.github.Electron',
}
const report: unknown[] = []
const evidence: Array<{ root: string; observations: any[] }> = []
let client: HelperClient | undefined
let awake: ReturnType<typeof spawn> | undefined
async function stop() {
  if (client) {
    await client.request('shutdown').catch(() => {})
    client.close()
    client = undefined
  }
  if (awake) {
    awake.kill('SIGTERM')
    await delay(150)
    report.push({
      caffeinate: awake.pid,
      ended: awake.exitCode !== null || awake.signalCode !== null,
    })
    awake = undefined
  }
  await delay(500)
}

try {
  for (const disabled of process.env.LITCH_CU_CHECK_PRIVATE === 'disabled'
    ? [true]
    : [false, true]) {
    const root = join(directory, disabled ? 'disabled' : 'normal')
    mkdirSync(root, { recursive: true, mode: 0o700 })
    const launcher = new MacLauncher({
      appPath,
      directory: root,
      version: null,
      async launch(path, env) {
        execFileSync('open', [
          '-n',
          '-g',
          ...Object.entries({
            ...env,
            HOME: join(directory, 'home'),
            CODEX_HOME: join(directory, 'codex'),
            LITCH_CU_PROBE_NO_PRIVATE: disabled ? '1' : '0',
          }).flatMap(([k, v]) => ['--env', `${k}=${v}`]),
          path,
        ])
      },
    })
    client = await launcher.establish('zh-CN', console.log)
    const activeClient = client
    const permission = (await client.request('permissions')) as any
    const diagnostics = (await client.request('diagnostics')) as any
    assert.equal(permission.accessibility, true)
    assert.equal(permission.screenRecording, true)
    assert.equal(diagnostics.responsibleIsSelf, true)
    assert.equal(diagnostics.ppid, 1)
    report.push({ disabled, permission, diagnostics })
    awake = spawn('/usr/bin/caffeinate', ['-d', '-i', '-w', String(client.hello?.pid)], {
      stdio: 'ignore',
    })
    const observations: any[] = []
    evidence.push({ root, observations })
    client.events.onAutomation = (notice) => {
      const item = notice as any
      observations.push({
        ...item,
        receivedAt: Date.now(),
        data: item.data ? `jpeg:${item.data.length}` : undefined,
      })
      if (item.event === 'frame') {
        writeFileSync(join(root, 'preview.jpg'), Buffer.from(item.data, 'base64'))
        void client
          ?.request('previewAck', { session: item.session, streamId: item.streamId, seq: item.seq })
          .catch(() => {})
      }
    }
    await delay(600)
    const capability = (await client.request('backgroundCapabilities')) as any
    report.push({ disabled, capability })
    if (disabled) assert.equal(capability.mouse, 'unavailable')
    const audit = () => read(join(root, 'foreground.json'))
    if (audit().frontBundle === 'com.apple.loginwindow') throw new Error('锁屏，停止验收')
    await until(() => audit().idle >= 3)
    checkUserIdle = () => {
      const current = audit()
      if (
        Date.now() / 1000 - current.sampledAt > 0.5 ||
        current.idle < 2 ||
        [
          'com.apple.loginwindow',
          'com.apple.UserNotificationCenter',
          'com.apple.SecurityAgent',
        ].includes(current.frontBundle)
      ) {
        throw new Error('检测到用户活动、系统提示或观察过期，立即让出 GUI')
      }
    }
    for (const [target, bundle] of Object.entries(targets)) {
      await command(target, 'reset')
      await command(target, 'focusText')
      await command(target, 'activate')
      await command('guard', 'activate')
      await until(() => audit().frontPid === state('guard').pid)
      const session = `${disabled ? 'disabled' : 'normal'}/${target}`
      const guardText = state('guard').text
      const originalCursor = audit()
      const base = { session, app: bundle, turnId: 'test' }
      const call = (method: string, params: Record<string, unknown> = {}, signal?: AbortSignal) => {
        checkUserIdle()
        return activeClient.request(
          method,
          { ...base, actionId: randomUUID(), ...params },
          15000,
          signal,
        )
      }
      const shot = (await call('getAppState')) as any
      writeFileSync(join(root, `${target}-model.jpg`), Buffer.from(shot.screenshot.data, 'base64'))
      await client.request('previewSubscribe', { session })
      await call('typeText', { text: 'abc中文' })
      assert.equal(state(target).text, 'abc中文')
      assert.equal(audit().frontPid, state('guard').pid)
      const point = (name: string) => {
        const s = state(target),
          p = s.points[name]
        return {
          x: ((p.x - s.frame.x) * shot.screenshot.width) / s.frame.width,
          y: ((p.y - s.frame.y) * shot.screenshot.height) / s.frame.height,
        }
      }
      const count = state(target).clicks
      const before = observations.length
      await call('click', point('button'))
      assert.equal(state(target).clicks, count + 1)
      assert.equal(audit().frontPid, state('guard').pid)
      const clickEvents = observations.slice(before)
      if (target === 'electron' || disabled) {
        assert.ok(clickEvents.some((e) => e.status === 'foreground'))
        assert.ok(clickEvents.some((e) => e.status === 'restored'))
      }
      const scroll = state(target).scrollY
      await call('scroll', { ...point('scroll'), direction: 'down', amount: 3 })
      report.push({
        disabled,
        target,
        action: 'scroll',
        before: scroll,
        after: state(target).scrollY,
        wheelEvents: state(target).events?.filter((e: any) => e.type === 22),
      })
      assert.ok(state(target).scrollY > scroll)
      const downAt = state(target).scrollY
      await call('scroll', { ...point('scroll'), direction: 'up', amount: 1 })
      assert.ok(state(target).scrollY < downAt, '反向滚动必须向上移动')
      assert.equal(audit().frontPid, state('guard').pid)
      await until(() => observations.some((e) => e.event === 'frame' && e.session === session))
      await client.request('previewPin', { session })
      await delay(400)
      assert.equal(audit().frontPid, state('guard').pid)
      await client.request('previewUnpin', { session })
      // 回合租约阻止另一个会话串输入。
      await client.request('getAppState', { ...base, session: 'other', actionId: randomUUID() })
      await assert.rejects(
        client.request('typeText', {
          ...base,
          session: 'other',
          actionId: randomUUID(),
          text: 'WRONG',
        }),
        /owns/,
      )
      await command(target, 'reset')
      await command(target, 'focusText')
      const controller = new AbortController()
      const typing = call('typeText', { text: '中'.repeat(1500) }, controller.signal)
      setTimeout(() => controller.abort(), 150)
      await assert.rejects(typing, /cancelled/)
      await delay(800)
      const length = state(target).text.length
      assert.ok(length > 0 && length < 1500)
      await delay(300)
      assert.equal(state(target).text.length, length)
      await client.request('turnEnded', { session })
      assert.equal(state('guard').text, guardText, '不能把文字打进前台守卫')
      assert.ok(
        Math.hypot(
          audit().cursorX - originalCursor.cursorX,
          audit().cursorY - originalCursor.cursorY,
        ) <= 1,
        '动作后应恢复原系统光标',
      )
      const capturePermission = (await client.request('permissions')) as any
      assert.equal(capturePermission.captureStatus, 'ready')
      report.push({
        disabled,
        target,
        typed: true,
        click: true,
        scroll: true,
        restored: true,
        guardUnchanged: true,
        cursorRestored: true,
        captureStatus: capturePermission.captureStatus,
        cancelLength: length,
        frames: observations.filter((e) => e.event === 'frame' && e.session === session).length,
      })
    }
    write(join(root, 'events.json'), observations)
    await stop()
  }
} finally {
  for (const { root, observations } of evidence) write(join(root, 'events.json'), observations)
  await stop()
  write(join(directory, 'report.json'), report)
}
console.log(
  JSON.stringify(
    report.filter((v: any) => !v.diagnostics),
    null,
    2,
  ),
)
