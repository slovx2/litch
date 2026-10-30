import assert from 'node:assert/strict'
import { test } from 'node:test'
import { enTasks } from '../src/i18n/en-tasks.ts'
import { zhTasks } from '../src/i18n/zh-CN-tasks.ts'
import { watchManagerNotices } from '../src/notify/manager-notice.ts'

test('经理通知使用独立开关、前台抑制、中英文说明、截断正文并按点击打开经理', () => {
  const manager = {
    id: 'm1',
    deviceId: 'remote',
    name: '发布经理',
    contact: { desktopNotification: true },
  }
  let listener
  let click
  let viewing = false
  let subtitle = zhTasks['notify.manager.decision']
  const notices = []
  const opened = []
  let stopped = 0
  const stop = watchManagerNotices({
    subscribe(fn) {
      listener = fn
      return () => stopped++
    },
    notify(notice) {
      notices.push(notice)
    },
    onClick(fn) {
      click = fn
      return () => stopped++
    },
    subtitle: () => subtitle,
    viewing: () => viewing,
    open: (...target) => opened.push(target),
  })
  const decision = { id: 'D-1', title: `核对\n${'内容'.repeat(200)}` }
  listener(manager, decision)
  assert.equal(notices[0].title, manager.name)
  assert.equal(notices[0].subtitle, '新决策待答')
  assert.equal(notices[0].body.length, 240)
  assert.ok(notices[0].body.endsWith('…'))
  assert.ok(!notices[0].body.includes('\n'))
  click('session:other')
  assert.equal(opened.length, 0)
  click(notices[0].id)
  assert.deepEqual(opened, [['remote', 'm1']])
  viewing = true
  listener(manager, decision)
  assert.equal(notices.length, 1)
  viewing = false
  manager.contact.desktopNotification = false
  listener(manager, decision)
  assert.equal(notices.length, 1)
  manager.contact.desktopNotification = true
  subtitle = enTasks['notify.manager.decision']
  listener(manager, { ...decision, title: 'Review release' })
  assert.equal(notices[1].subtitle, 'New decision awaiting your answer')
  assert.equal(notices[1].body, 'Review release')
  stop()
  assert.equal(stopped, 2)
})
