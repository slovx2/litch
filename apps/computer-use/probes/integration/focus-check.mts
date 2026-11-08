// 仅操作本仓库的测试窗口。通知加 5ms 采样记录整个动作期间的前台变化。
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { runComputerActions } from '../../../../third_party/litch-automation/packages/computer-use/src/batch.mjs'
import { MacLauncher } from '../../../../third_party/litch-automation/packages/computer-use/src/launcher-mac.mjs'
import { hidIdleSeconds } from '../coexist/idle.mjs'
import { PROBE_IDENTITY } from './identity.mjs'
import { probeAppPath } from './shared-probe.mjs'

const cu = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const root = mkdtempSync('/tmp/litch-cu-focus-')
const resultPath = process.argv[2]
if (!resultPath) throw new Error('需要结果 JSON 的绝对路径')
const report: any[] = []
const children: number[] = []
let client: any
let watcher: ReturnType<typeof spawn> | undefined
const events: any[] = []
const read = (name: string): any => JSON.parse(readFileSync(join(root, name, 'state.json'), 'utf8'))
async function until(fn: () => any, timeout = 8000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    try {
      if (fn()) return
    } catch {}
    await delay(50)
  }
  throw new Error('等待夹具超时')
}
async function command(name: string, action: string) {
  const id = randomUUID()
  writeFileSync(join(root, name, 'command.json'), JSON.stringify({ id, action }))
  await until(() => read(name).commandID === id)
  await delay(150)
}
try {
  await until(() => hidIdleSeconds() >= 3, 120000)
  for (const name of ['home', 'codex', 'appkit', 'guard', 'helper']) mkdirSync(join(root, name))
  for (const [name, title] of [
    ['appkit', 'Fixture'],
    ['guard', 'Guard'],
  ]) {
    execFileSync('open', [
      '-n',
      '-g',
      '--env',
      `HOME=${root}/home`,
      '--env',
      `CODEX_HOME=${root}/codex`,
      join(cu, '.artifacts/background', `Litch Background ${title}.app`),
      '--args',
      '--directory',
      join(root, name),
      '--role',
      name,
    ])
    await until(() => read(name))
    children.push(read(name).pid)
  }
  const launcher = new MacLauncher({
    identity: PROBE_IDENTITY,
    appPath: probeAppPath(),
    directory: join(root, 'helper'),
    version: null,
    async launch(path, env) {
      execFileSync('open', [
        '-n',
        '-g',
        ...Object.entries({
          ...env,
          HOME: `${root}/home`,
          CODEX_HOME: `${root}/codex`,
          LITCH_CU_PROBE_INTERRUPT_SELFTEST: process.env.LITCH_CU_PROBE_INTERRUPT_SELFTEST ?? '0',
        }).flatMap(([k, v]) => ['--env', `${k}=${v}`]),
        path,
      ])
    },
  })
  client = await launcher.establish('zh-CN', () => {})
  const permissions = await client.request('permissions')
  report.push({ permissions })
  assert.equal(permissions.accessibility, true, '探针缺少辅助功能权限；不请求或绕过系统授权')
  assert.equal(permissions.screenRecording, true, '探针缺少录屏权限')
  await delay(700)
  const capability = await client.request('backgroundCapabilities')
  report.push({ capability })
  if (process.env.LITCH_CU_PROBE_INTERRUPT_SELFTEST === '1')
    assert.equal(capability.mouse, 'interrupted')
  const watcherBinary = join(root, 'foreground-watch')
  execFileSync('swiftc', [join(cu, 'probes/integration/focus-watch.swift'), '-o', watcherBinary])
  watcher = spawn(watcherBinary, [], { stdio: ['pipe', 'pipe', 'inherit'] })
  let buffer = ''
  watcher.stdout?.on('data', (chunk) => {
    buffer += chunk
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) events.push({ ...JSON.parse(line), time: performance.now() })
  })
  await until(() => events.length)
  assert.ok(
    ![
      'com.apple.UserNotificationCenter',
      'com.apple.SecurityAgent',
      'com.apple.loginwindow',
    ].includes(events.at(-1).bundle),
    '存在系统提示或锁屏，不激活测试窗口',
  )
  await until(() => hidIdleSeconds() >= 3, 120000)
  await command('appkit', 'activate')
  await command('guard', 'activate')
  const base = { session: 'focus-matrix', turnId: 'test', app: read('appkit').bundleId }
  const call = (method: string, params: any = {}) =>
    client.request(method, { ...base, actionId: randomUUID(), ...params }, 15000)
  let shot: any
  async function measured(name: string, action: () => Promise<any>, foreground = false) {
    assert.equal(events.at(-1).pid, read('guard').pid, '前台已被用户切换，停止验收')
    const start = events.length
    const cursor = { x: events.at(-1).x, y: events.at(-1).y }
    const started = performance.now()
    const before = read('appkit')
    let result: any, error: string | undefined
    try {
      result = await action()
    } catch (e) {
      error = String(e)
    }
    await delay(150)
    const changes = events.slice(start)
    const away = changes.filter((e) => e.pid !== read('guard').pid)
    const restored = events.at(-1).pid === read('guard').pid
    const after = read('appkit')
    const row = {
      name,
      expectedForeground: foreground,
      error,
      text: result?.text,
      changes: changes.map((e) => ({ ...e, time: Math.round(e.time - started) })),
      restored,
      cursorStable: changes.every((e) => e.x === cursor.x && e.y === cursor.y),
      awayMs: away.length
        ? Math.round(
            (changes.find((e) => e.time > away[0].time && e.pid === read('guard').pid)?.time ??
              performance.now()) - away[0].time,
          )
        : 0,
      before: { text: before.text, clicks: before.clicks, scrollY: before.scrollY },
      after: {
        text: after.text,
        selection: after.selection,
        clicks: after.clicks,
        scrollY: after.scrollY,
        events: after.events,
      },
    }
    report.push(row)
    console.log(JSON.stringify({ name, error, awayMs: row.awayMs, restored }))
    if (!process.env.LITCH_CU_RECORD_BASELINE) {
      assert.equal(error, undefined)
      assert.equal(restored, true)
      if (foreground && name !== 'drag_cancel') {
        assert.ok(away.length > 0, `${name} 应覆盖真实前台回退`)
        assert.match(
          result.text,
          /briefly used the foreground; the previous app, window and focus were restored/,
        )
      }
      if (!foreground) assert.equal(away.length, 0, `${name} 改了前台`)
      if (!foreground)
        assert.equal(row.cursorStable, true, `${name} 期间真实鼠标移动，需排除用户活动后复测`)
    }
  }
  await measured('get_app_state', async () => {
    shot = await call('getAppState')
    return shot
  })
  writeFileSync(join(root, 'tree.json'), JSON.stringify(shot, null, 2))
  const point = (name: string) => {
    const s = read('appkit'),
      p = s.points[name]
    return {
      x: ((p.x - s.frame.x) * shot.screenshot.width) / s.frame.width,
      y: ((p.y - s.frame.y) * shot.screenshot.height) / s.frame.height,
    }
  }
  const tree = shot.text as string
  const index = (label: string) =>
    Number(
      tree
        .split('\n')
        .find((l) => l.includes(label))
        ?.match(/\[(\d+)\]/)?.[1],
    )
  const button = index('计数按钮'),
    text = index('TextArea')
  assert.ok(button > 0 && text > 0, '未找到测试控件')
  await measured('click_element', () => call('click', { element: button }))
  assert.equal(read('appkit').clicks, 1)
  await measured('click_coordinate', () => call('click', point('button')))
  assert.equal((await client.request('backgroundCapabilities')).mouse, 'available')
  assert.equal(read('appkit').clicks, 2)
  await measured('click_double', () => call('click', { ...point('text'), count: 2 }))
  await measured('click_right', () => call('click', { ...point('button'), button: 'right' }))
  await measured('type_text', () => call('typeText', { element: text, text: 'abcdef中文' }))
  assert.equal(read('appkit').text, 'abcdef中文')
  await measured('press_key', () => call('pressKey', { key: 'Left' }))
  await measured('press_key_command', () => call('pressKey', { key: 'cmd+a' }))
  assert.equal(read('appkit').selection.length, 8)
  await measured('scroll', () =>
    call('scroll', { ...point('scroll'), direction: 'down', amount: 2 }),
  )
  assert.ok(read('appkit').scrollY > 0)
  await measured('set_value', () => call('setValue', { element: text, value: 'abcdef' }))
  await measured('select_text', () => call('selectText', { element: text, text: 'bcd' }))
  assert.deepEqual(read('appkit').selection, { location: 1, length: 3 })
  const from = point('textStart'),
    to = point('textEnd')
  await measured(
    'drag',
    () => call('drag', { from_x: from.x, from_y: from.y, to_x: to.x, to_y: to.y }),
    true,
  )
  if (!process.env.LITCH_CU_RECORD_BASELINE) assert.equal(read('appkit').selection.length, 6)
  if (!process.env.LITCH_CU_RECORD_BASELINE) {
    await measured(
      'drag_cancel',
      async () => {
        const controller = new AbortController()
        const request = client.request(
          'drag',
          {
            ...base,
            actionId: randomUUID(),
            from_x: from.x,
            from_y: from.y,
            to_x: to.x,
            to_y: to.y,
          },
          15000,
          controller.signal,
        )
        const timer = setTimeout(() => controller.abort(), 180)
        try {
          await assert.rejects(request, /cancelled/)
        } finally {
          clearTimeout(timer)
        }
        await delay(500)
        // NSTextView 的跟踪循环直接消费 mouseUp，不能用本地 sendEvent 监视的末项判断松开。
        assert.equal(events.at(-1).leftDown, false, '取消后系统鼠标按钮必须释放')
        await command('appkit', 'focusText')
        return { text: '取消后系统按钮已松开，目标已响应后续命令' }
      },
      true,
    )
  }
  await measured('press_key_fallback', () => call('pressKey', { key: 'cmd+shift+a' }), true)
  const methods: Record<string, string> = {
    set_value: 'setValue',
    select_text: 'selectText',
    get_app_state: 'getAppState',
  }
  await measured('run_actions', async () => {
    const result = await runComputerActions(
      {
        tool: 'run_actions',
        arguments: {
          actions: [
            { tool: 'set_value', arguments: { app: base.app, element: text, value: 'batch' } },
            { tool: 'select_text', arguments: { app: base.app, element: text, text: 'batch' } },
          ],
        },
      } as any,
      { signal: new AbortController().signal } as any,
      async (invocation) => {
        const value = await call(methods[invocation.tool], invocation.arguments)
        return { success: true, contentItems: [{ type: 'inputText', text: value.text }] }
      },
    )
    assert.equal(result.success, true)
    assert.equal(read('appkit').selection.length, 5)
    return result
  })
} catch (error) {
  report.push({ fatal: String(error), root })
  process.exitCode = 1
} finally {
  if (client) {
    await client.request('shutdown').catch(() => {})
    client.close()
  }
  watcher?.stdin?.end()
  for (const name of ['appkit', 'guard']) {
    try {
      writeFileSync(
        join(root, name, 'command.json'),
        JSON.stringify({ id: randomUUID(), action: 'quit' }),
      )
    } catch {}
  }
  await delay(150)
  for (const pid of children) {
    try {
      process.kill(pid, 'SIGTERM')
    } catch {}
  }
  writeFileSync(resultPath, JSON.stringify({ root, report }, null, 2))
  console.log(resultPath)
}
