// 将原探针像 Electron 一样序列化进隔离页面夹具；真实 until 使用受控时钟，不花20秒等待负例。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { serviceSession } from '../../apps/desktop/src/probe-remote-service-more.mts'
import { installTerminalKit } from '../../apps/desktop/src/probe-terminal-kit.mts'

function fixture(mode, permissionDelay = 96) {
  let now = 0
  let readyAt = Infinity
  let created = false
  let last = ''
  let droppedAt = -Infinity
  let opened = false
  let exited = false
  const writes = []
  const sends = []
  const rows = []
  const ready = () => mode === 'delayed' && now >= readyAt
  const error = () =>
    mode.includes('error')
      ? '项目权限读取失败'
      : ready() || mode === 'disabled'
        ? ''
        : '正在读取项目权限…'
  const text = (textContent) => ({ textContent })
  const away = () => now - droppedAt < 32
  const group = {
    classList: { contains: () => away() },
    querySelector: () => text('远程设备'),
    querySelectorAll: () => [zone],
  }
  const zone = { dataset: { workspace: 'project' }, querySelector: () => text('远程区') }
  const row = {
    textContent: '首句',
    closest: () => ({ dataset: { group: 'project' } }),
    querySelector: () => ({ title: 'Pi' }),
  }
  class Textarea {
    get value() {
      return this.words ?? ''
    }
    set value(words) {
      this.words = words
      writes.push(words)
      if (writes.length === 1) readyAt = now + permissionDelay
    }
    dispatchEvent(event) {
      if (event.type !== 'keydown') return
      assert.ok(ready(), '权限未就绪时不能发 Enter')
      sends.push(this.value)
      created = true
      last = `收到：${this.value} 一点一点出来的`
    }
  }
  const input = new Textarea()
  const document = {
    visibilityState: 'visible',
    querySelector(selector) {
      switch (selector) {
        case '.sb-link.new':
          return { click() {} }
        case '.new-hero':
          return created ? null : {}
        case '.pick[data-kind="device"] .pick-btn':
          return text('远程设备')
        case '.pick[data-kind="workspace"] .pick-btn':
          return text('远程区')
        case '.crumb .chip':
          return { title: 'Pi' }
        case 'textarea.cmp-text':
          return input
        case '.dock .send':
          return { disabled: !ready() && !mode.startsWith('enabled-') }
        case '.dock .cmp-hint.err':
          return mode.includes('error') ? null : text(error())
        case '.dock [role="alert"]':
          return mode.includes('error') ? text(error()) : null
        case '.ss-row:not(.projection-group *).sel':
          return row
        case '.crumb .dev':
          return text('远程设备')
        case '.crumb span.ell':
          return text('远程区')
        case '.md.live':
          return text(last)
        case '.term-status[data-state="away"]':
          return away() ? text('设备未连接') : null
        case '.term-status':
          return away() ? text('设备未连接') : null
        default:
          return null
      }
    },
    querySelectorAll(selector) {
      if (selector === '.dev-group') return [group]
      if (selector === '.turn') return [text(last)]
      return []
    },
  }
  const context = {
    window: {},
    document,
    performance: { now: () => now },
    localStorage: { getItem: () => null },
    HTMLTextAreaElement: Textarea,
    Event: class {
      constructor(type) {
        this.type = type
      }
    },
    KeyboardEvent: class {
      constructor(type) {
        this.type = type
      }
    },
    requestAnimationFrame: (callback) =>
      queueMicrotask(() => {
        now += 16
        callback()
      }),
    setTimeout: (callback, ms) => {
      // frame的兜底在夹具中不需要触发；until/seen仍逐次推进真实预算。
      if (ms !== 1000)
        queueMicrotask(() => {
          now += ms
          callback()
        })
    },
  }
  runInNewContext(`(${installTerminalKit.toString()})()`, context)
  const kit = context.window.__termKit
  const waits = []
  const realUntil = kit.until
  kit.until = (what, check, ms) => {
    waits.push(what)
    return realUntil(what, check, ms)
  }
  // 后半段连接/终端使用受控夹具状态，首句使用原始 DOM 查询、frame 和 until。
  Object.assign(kit, {
    signal: () => {
      droppedAt = now
    },
    toggle: () => {
      opened = !opened
    },
    panelOpen: () => opened,
    tabs: () => [{ state: exited ? 'exited' : away() ? 'away' : 'running' }],
    calm: async () => {},
    prompt: async () => {},
    see: async () => {},
    run(command) {
      if (command.includes('Hello')) rows.push('Hello-42')
      if (command.includes('go-')) rows.push('go-2', 'after-drop-42')
      if (command === 'exit') exited = true
    },
    rows: () => rows,
    screen: () => `\n${rows.join('\n')}`,
  })
  return {
    run: () => runInNewContext(`(${serviceSession.toString()})('远程设备', '首句')`, context),
    writes,
    sends,
    waits,
    elapsed: () => now,
  }
}

test('项目权限延迟到首句写入之后才返回：原探针等待就绪，首句只写/发一次，最终采样无阻塞', async () => {
  const page = fixture('delayed')
  const seen = await page.run()
  assert.equal(seen.stillBlocked, '')
  assert.equal(seen.created, true)
  assert.equal(seen.inWorkspace, true)
  assert.equal(seen.recovered, true)
  assert.equal(seen.sentAfter, true)
  assert.equal(seen.usable, true)
  assert.equal(page.writes.filter((words) => words === '首句').length, 1)
  assert.equal(page.sends.filter((words) => words === '首句').length, 1)
  assert.equal(page.sends.length, 3, '首句、断线时、恢复后三条各发一次')
  assert.ok(page.waits.includes('远程项目权限就绪且首句可发送'))
})

test('权限在写入首句的下一帧返回：成功创建不能留下此前的 loading 采样', async () => {
  // 夜间旧探针先采样、再写首句并等一帧，会同时报 loading 和 created=true。
  const page = fixture('delayed', 16)
  const seen = await page.run()
  assert.equal(seen.created, true)
  assert.equal(seen.stillBlocked, '')
  assert.equal(page.writes.filter((words) => words === '首句').length, 1)
  assert.equal(page.sends.filter((words) => words === '首句').length, 1)
})

for (const mode of ['loading', 'error', 'enabled-loading', 'enabled-error', 'disabled']) {
  test(`项目权限一直${mode}：现有20秒预算超时判失败、不发送`, async () => {
    const page = fixture(mode)
    await assert.rejects(
      page.run(),
      mode === 'disabled'
        ? /发送阻塞：发送按钮不可用/
        : mode.includes('loading')
          ? /发送阻塞：正在读取项目权限/
          : /发送阻塞：项目权限读取失败/,
    )
    assert.ok(page.elapsed() >= 20000)
    assert.ok(page.elapsed() < 21000)
    assert.deepEqual(page.writes, ['首句'])
    assert.deepEqual(page.sends, [])
  })
}
