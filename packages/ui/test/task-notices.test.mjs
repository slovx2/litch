import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { transformSync } from 'esbuild'
import { translator } from '../src/i18n/index.ts'
import * as describe from '../src/tasks/describe.ts'

// 执行通知组件的真实订阅和点击逻辑；替身只负责外壳与订阅，不发系统通知。
for (const lang of ['zh-CN', 'en'])
  test(`失败通知带任务、时间、原因与未启动说明，点击打开任务记录：${lang}`, () => {
    const t = translator(lang)
    const notices = [],
      routes = [],
      opened = [],
      cleanup = []
    let finished, clicked
    const shell = {
      notify: (value) => notices.push(value),
      onNotifyClick: (fn) => {
        clicked = fn
        return () => {}
      },
    }
    const replica = {
      store: {
        get: (key) => (key.startsWith('device:') ? { name: 'remote-fixture' } : { id: 'large' }),
      },
      onTaskRunAsking: () => () => {},
      onTaskRunFinished: (fn) => {
        finished = fn
        return () => {}
      },
    }
    const stubs = {
      '@litch/core': { keys: { device: (id) => `device:${id}`, summary: () => 'summary' } },
      react: { useEffect: (fn) => cleanup.push(fn()), useRef: (current) => ({ current }) },
      '../app/actions.ts': { requestTasks: (route) => routes.push(route) },
      '../app/appearance.ts': { useT: () => t },
      '../app/services.tsx': { useServices: () => ({ replica }) },
      './describe.ts': describe,
      './notify-pref.ts': { notifySuccess: () => true },
    }
    const { code } = transformSync(
      readFileSync(new URL('../src/tasks/TaskNotices.tsx', import.meta.url), 'utf8'),
      { loader: 'tsx', format: 'cjs' },
    )
    const module = { exports: {} }
    const previous = globalThis.window
    globalThis.window = { litchShell: shell }
    try {
      new Function('require', 'module', 'exports', code)(
        (id) => {
          assert.ok(id in stubs, `未定义依赖：${id}`)
          return stubs[id]
        },
        module,
        module.exports,
      )
      module.exports.TaskNotices({ onOpen: (route) => opened.push(route) })
      const now = Date.now()
      const run = {
        id: 'failed-before-start',
        deviceId: 'remote',
        taskId: 'schedule',
        threadId: 'large',
        turnId: null,
        status: 'failed',
        scheduledFor: now - 30000,
        startedAt: null,
        finishedAt: now,
        error: {
          code: 'internal',
          message: '运行时响应超过 WebSocket 100 MiB 上限，请使用分页读取历史',
        },
      }
      finished(run, { name: '定时推进' })
      assert.equal(notices[0].failure, true)
      assert.ok(notices[0].title.includes('定时推进'))
      assert.ok(notices[0].body.includes('remote-fixture'))
      assert.ok(notices[0].body.includes(describe.whenText(now, now, t)))
      assert.ok(notices[0].body.includes('100 MiB'))
      assert.ok(
        notices[0].body.includes(
          lang === 'zh-CN' ? '未记录到回合启动' : 'No turn start was recorded',
        ),
      )
      assert.ok(
        notices[0].body.includes(
          lang === 'zh-CN' ? '后续运行仍可能失败' : 'Later runs may fail again',
        ),
      )
      clicked(run.id)
      assert.deepEqual(routes, [{ view: 'detail', deviceId: 'remote', taskId: 'schedule' }])
      assert.deepEqual(opened, [])
      finished(
        { ...run, id: 'later-success', status: 'succeeded', error: null, turnId: 'turn' },
        { name: '定时推进' },
      )
      clicked('later-success')
      assert.deepEqual(opened, [{ deviceId: 'remote', sessionId: 'large' }])
    } finally {
      for (const fn of cleanup) fn?.()
      globalThis.window = previous
    }
  })
