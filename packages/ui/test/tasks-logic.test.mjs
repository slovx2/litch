// 定时任务界面里不靠浏览器就能测的那几块：日程和时间点的人话（describe.ts）、表单和任务之间怎么换、先查哪几样（form.ts）。
// 跑法：npm run test --prefix packages/ui（Node 直接读 .ts，不用先构建）。
import assert from 'node:assert/strict'
import { test } from 'node:test'

const { translator } = await import('../src/i18n/index.ts')
const { daysText, scheduleLine, scheduleText, whenText, errorText, runTone } = await import(
  '../src/tasks/describe.ts'
)
const { blankForm, checkForm, draftOf, formOf, patchOf, scheduleOf, toggleDay } = await import(
  '../src/tasks/form.ts'
)

const zh = translator('zh-CN')
const en = translator('en')
/** 2026-10-19 10:00，本地时区 */
const NOW = new Date(2026, 9, 19, 10, 0).getTime()

test('星期：连着三天以上说成“到”，否则一个个列；每周的写法中文只写一个字', () => {
  assert.equal(daysText(['MO', 'TU', 'WE', 'TH', 'FR'], zh), '周一到周五')
  assert.equal(daysText(['FR', 'MO'], zh), '周一、周五')
  assert.equal(daysText(['MO', 'TH'], zh, true), '一、四')
  assert.equal(daysText(['SA', 'SU'], en), 'Sat, Sun')
  assert.equal(daysText(['WE', 'TH', 'FR', 'SA'], en), 'Wed–Sat')
})

test('日程的人话：七种都说得出，整小时的间隔按小时说，29 日以后提醒短月份', () => {
  const cases = [
    [{ type: 'daily', time: '09:00' }, '每天 09:00', 'Daily at 09:00'],
    [{ type: 'weekdays', time: '18:30' }, '工作日 18:30', 'Weekdays at 18:30'],
    [
      { type: 'weekly', days: ['MO', 'TH'], time: '10:30' },
      '每周一、四 10:30',
      'Every Mon, Thu at 10:30',
    ],
    [{ type: 'monthly', day: 1, time: '08:00' }, '每月 1 日 08:00', 'Monthly on day 1 at 08:00'],
    [{ type: 'interval', minutes: 30 }, '每 30 分钟', 'Every 30 minutes'],
    [{ type: 'interval', minutes: 120 }, '每 2 小时', 'Every 2 hours'],
    [
      { type: 'hourly', intervalHours: 1, minute: 5, days: null },
      '每小时第 05 分',
      'Hourly at :05',
    ],
    [
      { type: 'hourly', intervalHours: 4, minute: 0, days: ['MO', 'TU', 'WE', 'TH', 'FR'] },
      '每 4 小时，第 00 分（周一到周五）',
      'Every 4 hours at :00 (Mon–Fri)',
    ],
    [{ type: 'once', at: '2026-10-30T16:00' }, '一次：10月30日 16:00', 'Once: Oct 30, 16:00'],
    [
      { type: 'once', at: '2027-01-02T08:00' },
      '一次：2027年1月2日 08:00',
      'Once: Jan 2, 2027, 08:00',
    ],
  ]
  for (const [schedule, zhText, enText] of cases) {
    assert.equal(scheduleText(schedule, zh, NOW), zhText)
    assert.equal(scheduleText(schedule, en, NOW), enText)
  }
  assert.match(scheduleText({ type: 'monthly', day: 31, time: '18:00' }, zh, NOW), /最后一天/)
})

test('任务的时区和这台电脑不一样时，日程后面带上时区名', () => {
  const task = { schedule: { type: 'daily', time: '02:00' }, timezone: 'UTC' }
  assert.equal(scheduleLine(task, zh, 'UTC', NOW), '每天 02:00')
  assert.equal(scheduleLine(task, zh, 'Asia/Shanghai', NOW), '每天 02:00 · UTC')
})

test('时间点：今天、明天、昨天带时刻，别的写月日，不是今年的带年', () => {
  const at = (y, m, d, h, min) => new Date(y, m - 1, d, h, min).getTime()
  assert.equal(whenText(at(2026, 10, 19, 9, 5), NOW, zh), '今天 09:05')
  assert.equal(whenText(at(2026, 10, 20, 9, 0), NOW, zh), '明天 09:00')
  assert.equal(whenText(at(2026, 10, 18, 23, 0), NOW, en), 'Yesterday 23:00')
  assert.equal(whenText(at(2026, 11, 3, 7, 0), NOW, zh), '11月3日 07:00')
  assert.equal(whenText(at(2025, 12, 31, 7, 0), NOW, en), 'Dec 31, 2025, 07:00')
})

test('失败的原因：种类一句人话，后面跟设备的原话；状态归成几种样式', () => {
  assert.equal(
    errorText({ code: 'cwdMissing', message: 'no such dir' }, zh),
    '工作目录不存在：no such dir',
  )
  assert.equal(
    errorText({ code: 'timedOut', message: '' }, en),
    'The turn ran too long and was interrupted',
  )
  assert.deepEqual(['succeeded', 'failed', 'running', 'queued', 'canceled'].map(runTone), [
    'ok',
    'err',
    'run',
    'wait',
    'off',
  ])
})

const place = {
  deviceId: 'local',
  harness: 'claude',
  workspaceId: 'ws1',
  cwd: '/w/litch',
  now: NOW,
}
const task = {
  id: 't1',
  deviceId: 'local',
  name: '周报',
  prompt: '整理周报',
  schedule: { type: 'weekly', days: ['MO', 'FR'], time: '09:00' },
  timezone: 'Asia/Shanghai',
  status: 'active',
  target: {
    kind: 'newThread',
    harness: 'claude',
    cwd: '/w/litch',
    workspaceId: 'ws1',
    settings: { model: 'opus', effort: null, permission: null },
  },
  origin: { kind: 'client' },
  revision: 3,
  createdAt: NOW,
  updatedAt: NOW,
  nextRunAt: null,
  lastRunAt: null,
  lastRun: null,
  lastError: null,
  unreadRuns: 0,
}

test('表单换成要发的：新建带全套，时区 null 是设备的，暂停的带 status', () => {
  const form = { ...blankForm(place), name: ' 日报 ', prompt: '写日报', paused: true }
  assert.deepEqual(draftOf(form), {
    name: '日报',
    prompt: '写日报',
    schedule: { type: 'daily', time: '09:00' },
    timezone: null,
    target: {
      kind: 'newThread',
      harness: 'claude',
      cwd: '/w/litch',
      workspaceId: 'ws1',
      settings: { model: null, effort: null, permission: null },
    },
    status: 'paused',
  })
  const thread = blankForm({ ...place, threadId: 's8' })
  assert.deepEqual(draftOf({ ...thread, name: 'x', prompt: 'y' }).target, {
    kind: 'thread',
    harness: 'claude',
    threadId: 's8',
  })
})

test('几种日程的栏换成协议的样子：星期按周一在前排，每小时挑满七天等于不挑', () => {
  const form = blankForm(place)
  assert.deepEqual(scheduleOf({ ...form, repeat: 'weekly', days: ['FR', 'MO'] }), {
    type: 'weekly',
    days: ['MO', 'FR'],
    time: '09:00',
  })
  const all = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU']
  assert.equal(scheduleOf({ ...form, repeat: 'hourly', hourlyDays: all }).days, null)
  assert.deepEqual(scheduleOf({ ...form, repeat: 'once', at: '2026-10-30T16:00' }), {
    type: 'once',
    at: '2026-10-30T16:00',
  })
  assert.deepEqual(toggleDay(['FR'], 'MO'), ['MO', 'FR'])
  assert.deepEqual(toggleDay(['MO', 'FR'], 'MO'), ['FR'])
})

test('编辑：换回表单再比，只带改了的；什么都没改是 null', () => {
  const form = formOf(task)
  assert.equal(form.repeat, 'weekly')
  assert.deepEqual(form.days, ['MO', 'FR'])
  assert.equal(patchOf(task, form), null)
  assert.deepEqual(patchOf(task, { ...form, time: '10:30', name: '周报 v2' }), {
    name: '周报 v2',
    schedule: { type: 'weekly', days: ['MO', 'FR'], time: '10:30' },
  })
  assert.deepEqual(
    patchOf(task, { ...form, settings: { model: 'sonnet', effort: 'high', permission: null } }),
    { target: { settings: { model: 'sonnet', effort: 'high', permission: null } } },
  )
})

test('先查的几样：只查这一种日程要的栏，名字、提示词、目录、会话、时区', () => {
  const known = (zone) => zone !== 'Mars/Base'
  const form = { ...blankForm(place), name: 'a', prompt: 'b' }
  assert.deepEqual(checkForm(form, known), {})
  assert.deepEqual(Object.keys(checkForm({ ...form, name: '  ', prompt: '' }, known)).sort(), [
    'name',
    'prompt',
  ])
  assert.equal(checkForm({ ...form, repeat: 'weekly', days: [] }, known).days, 'tasks.check.days')
  assert.equal(
    checkForm({ ...form, repeat: 'interval', minutes: 3 }, known).minutes,
    'tasks.check.minutes',
  )
  assert.equal(
    checkForm({ ...form, repeat: 'hourly', hours: 24 }, known).hours,
    'tasks.check.hours',
  )
  assert.equal(
    checkForm({ ...form, repeat: 'once', at: '2026-13-01T00:00' }, known).at,
    'tasks.check.at',
  )
  // 每天的时刻填坏了；换成每隔几分钟就不查时刻
  assert.equal(checkForm({ ...form, time: '25:00' }, known).time, 'tasks.check.time')
  assert.equal(checkForm({ ...form, time: '25:00', repeat: 'interval' }, known).time, undefined)
  assert.equal(checkForm({ ...form, timezone: 'Mars/Base' }, known).timezone, 'tasks.check.zone')
  assert.equal(checkForm({ ...form, cwd: ' ' }, known).cwd, 'tasks.check.cwd')
  const thread = { ...form, target: 'thread', threadId: null }
  assert.equal(checkForm(thread, known).threadId, 'tasks.check.session')
  assert.equal(checkForm(thread, known, true).threadId, undefined)
})
