// 定时任务的纯逻辑：表单和日程来回换（src/screens/tasks/schedule.ts）、日程的人话描述、时间的说法（when.ts）。
// 文案只用 tasks.* 的键：这里自己拿 messages/tasks.ts 拼一个翻译函数，不经 src/ui/i18n.ts（它要 React 和 expo）。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { zhCN as desktop } from '../../../packages/ui/src/i18n/zh-CN.ts'
import {
  defaultForm,
  describeSchedule,
  formOf,
  readForm,
  tidyDate,
  tidyTime,
} from '../src/screens/tasks/schedule.ts'
import { whenText } from '../src/screens/tasks/when.ts'
import * as messages from '../src/ui/messages/tasks.ts'

function tr(lang) {
  const table = lang === 'en' ? messages.en : messages.zhCN
  const t = (key, args = {}) => {
    const entry = table[key]
    assert.ok(entry !== undefined, `没有这个键：${key}`)
    if (typeof entry === 'function') return entry(args)
    return entry.replace(/\{(\w+)\}/g, (whole, name) => String(args[name] ?? whole))
  }
  t.lang = lang
  return t
}
const zh = tr('zh-CN')
const en = tr('en')

test('中英文的键一样多；没有和桌面界面撞名的键（撞了会遮住那边的句子）', () => {
  assert.deepEqual(Object.keys(messages.en).sort(), Object.keys(messages.zhCN).sort())
  assert.deepEqual(
    Object.keys(messages.zhCN).filter((key) => key in desktop),
    [],
  )
})

test('时刻和日期的写法', () => {
  assert.equal(tidyTime('9'), '09:00')
  assert.equal(tidyTime('9:05'), '09:05')
  assert.equal(tidyTime('9:5'), '09:05')
  assert.equal(tidyTime('0930'), '09:30')
  assert.equal(tidyTime(' 23:59 '), '23:59')
  assert.equal(tidyTime('24:00'), null)
  assert.equal(tidyTime('12:60'), null)
  assert.equal(tidyTime('abc'), null)
  assert.equal(tidyDate('2026-2-3'), '2026-02-03')
  assert.equal(tidyDate('2026-02-30'), null)
  assert.equal(tidyDate('2026/02/03'), null)
})

test('每种日程填回表单再读出来不变', () => {
  const schedules = [
    { type: 'once', at: '2026-10-20T09:30' },
    { type: 'interval', minutes: 45 },
    { type: 'hourly', intervalHours: 2, minute: 15, days: null },
    { type: 'hourly', intervalHours: 1, minute: 0, days: ['MO', 'FR'] },
    { type: 'daily', time: '08:00' },
    { type: 'weekdays', time: '18:30' },
    { type: 'weekly', days: ['MO', 'WE'], time: '09:00' },
    { type: 'monthly', day: 31, time: '07:00' },
  ]
  for (const schedule of schedules) {
    const read = readForm(formOf(schedule, '2026-10-19'), 5)
    assert.deepEqual(read, { ok: true, schedule }, schedule.type)
  }
})

test('换日程种类时填过的几栏留着；星期按周一到周日排', () => {
  const form = { ...defaultForm('2026-10-19'), time: '07:15', days: ['FR', 'MO', 'FR'] }
  assert.deepEqual(readForm({ ...form, type: 'weekly' }, 5), {
    ok: true,
    schedule: { type: 'weekly', days: ['MO', 'FR'], time: '07:15' },
  })
  assert.deepEqual(readForm({ ...form, type: 'daily' }, 5), {
    ok: true,
    schedule: { type: 'daily', time: '07:15' },
  })
  assert.equal(defaultForm('2026-12-31').date, '2027-01-01', '一次性的默认是明天')
})

test('读不成日程时指出哪一栏', () => {
  const form = defaultForm('2026-10-19')
  assert.equal(readForm({ ...form, time: '25:00' }, 5).field, 'time')
  assert.equal(readForm({ ...form, type: 'weekly', days: [] }, 5).field, 'days')
  const tooDense = readForm({ ...form, type: 'interval', minutes: '3' }, 5)
  assert.equal(tooDense.field, 'minutes')
  assert.deepEqual(tooDense.args, { min: 5, max: 10080 })
  assert.equal(readForm({ ...form, type: 'monthly', monthDay: '32' }, 5).field, 'monthDay')
  assert.equal(readForm({ ...form, type: 'hourly', minute: '1.5' }, 5).field, 'minute')
  assert.equal(
    readForm({ ...form, type: 'hourly', hourlyAllDays: false, days: [] }, 5).field,
    'days',
  )
  assert.equal(readForm({ ...form, type: 'once', date: '明天' }, 5).field, 'date')
})

test('日程的人话描述（中文）', () => {
  const say = (schedule, zone = null) => describeSchedule(schedule, zone, 'Asia/Shanghai', zh)
  assert.equal(say({ type: 'daily', time: '09:00' }), '每天 09:00')
  assert.equal(say({ type: 'weekdays', time: '09:00' }), '工作日 09:00')
  assert.equal(say({ type: 'weekly', days: ['WE', 'MO'], time: '09:00' }), '每周一、周三 09:00')
  assert.equal(
    say({ type: 'weekly', days: ['MO', 'TU', 'WE', 'TH', 'FR'], time: '09:00' }),
    '工作日 09:00',
  )
  assert.equal(say({ type: 'monthly', day: 15, time: '10:00' }), '每月 15 日 10:00')
  assert.match(say({ type: 'monthly', day: 31, time: '10:00' }), /月末/)
  assert.equal(say({ type: 'interval', minutes: 30 }), '每 30 分钟')
  assert.equal(say({ type: 'interval', minutes: 120 }), '每 2 小时')
  assert.equal(say({ type: 'hourly', intervalHours: 1, minute: 5, days: null }), '每小时第 05 分')
  assert.equal(
    say({ type: 'hourly', intervalHours: 3, minute: 0, days: ['MO', 'TU', 'WE', 'TH', 'FR'] }),
    '每 3 小时，第 00 分（工作日）',
  )
  assert.equal(say({ type: 'once', at: '2026-10-20T09:30' }), '一次：2026-10-20 09:30')
  assert.equal(
    say({ type: 'daily', time: '09:00' }, 'Asia/Shanghai'),
    '每天 09:00',
    '同一个时区不带',
  )
  assert.equal(
    say({ type: 'daily', time: '09:00' }, 'America/New_York'),
    '每天 09:00（America/New_York）',
  )
})

test('日程的人话描述（英文，单复数）', () => {
  const say = (schedule) => describeSchedule(schedule, null, 'UTC', en)
  assert.equal(say({ type: 'daily', time: '09:00' }), 'Daily at 09:00')
  assert.equal(
    say({ type: 'weekly', days: ['MO', 'WE'], time: '09:00' }),
    'Every Mon, Wed at 09:00',
  )
  assert.equal(say({ type: 'interval', minutes: 60 }), 'Every hour')
  assert.equal(say({ type: 'interval', minutes: 5 }), 'Every 5 minutes')
  assert.equal(
    say({ type: 'hourly', intervalHours: 1, minute: 30, days: ['SA', 'SU'] }),
    'Hourly at :30 (Sat, Sun)',
  )
})

test('时间说成今天、明天、昨天、日期；不是今年的带年份', () => {
  // 2026-10-19 12:00 UTC
  const now = Date.UTC(2026, 9, 19, 12, 0)
  const say = (ms) => whenText(ms, now, zh, 'UTC')
  assert.equal(say(Date.UTC(2026, 9, 19, 9, 5)), '今天 09:05')
  assert.equal(say(Date.UTC(2026, 9, 20, 0, 0)), '明天 00:00')
  assert.equal(say(Date.UTC(2026, 9, 18, 23, 10)), '昨天 23:10')
  assert.equal(say(Date.UTC(2026, 9, 25, 9, 0)), '10-25 09:00')
  assert.equal(say(Date.UTC(2027, 0, 2, 9, 0)), '2027-01-02 09:00')
  // 换个时区：UTC 的 23:30 在上海已经是第二天
  assert.equal(whenText(Date.UTC(2026, 9, 19, 23, 30), now, zh, 'Asia/Shanghai'), '明天 07:30')
})

const task = (over = {}) => ({
  id: 't1',
  deviceId: 'd1',
  name: '日报',
  prompt: '写日报',
  schedule: { type: 'daily', time: '09:00' },
  timezone: 'UTC',
  status: 'active',
  target: { kind: 'thread', harness: 'pi', threadId: 's1' },
  origin: { kind: 'client' },
  revision: 1,
  createdAt: 0,
  updatedAt: 0,
  nextRunAt: null,
  lastRunAt: null,
  lastRun: null,
  lastError: null,
  unreadRuns: 0,
  ...over,
})
const run = (over = {}) => ({
  id: 'r1',
  taskId: 't1',
  deviceId: 'd1',
  trigger: 'scheduled',
  scheduledFor: 0,
  coalesced: 0,
  status: 'succeeded',
  harness: 'pi',
  threadId: 's1',
  startedAt: null,
  finishedAt: null,
  summary: null,
  error: null,
  read: true,
  ...over,
})

test('任务一行：日程、下一次或状态、最近一次、未读和记号', async () => {
  const { taskLines } = await import('../src/screens/tasks/lines.ts')
  const now = Date.UTC(2026, 9, 19, 12, 0)
  const next = Date.UTC(2026, 9, 20, 9, 0)
  const plain = taskLines(task({ nextRunAt: next }), now, 'UTC', zh)
  assert.equal(plain.title, '日报')
  assert.match(plain.detail, /^每天 09:00\n/)
  assert.match(plain.detail, /下一次/)
  assert.equal(plain.meta, undefined)
  assert.equal(plain.mark, 'idle')

  const busy = taskLines(
    task({ lastRun: run({ status: 'running', startedAt: now }) }),
    now,
    'UTC',
    zh,
  )
  assert.equal(busy.mark, 'running')
  assert.match(busy.detail, /最近一次正在跑 今天 \d\d:\d\d/)

  const failed = taskLines(
    task({ unreadRuns: 2, lastError: { code: 'turnFailed', message: 'boom' } }),
    now,
    'UTC',
    zh,
  )
  assert.equal(failed.mark, 'error')
  assert.equal(failed.meta, '2 次没看')
  assert.equal(taskLines(task({ unreadRuns: 1 }), now, 'UTC', zh).mark, 'unread')
  assert.match(taskLines(task({ status: 'paused' }), now, 'UTC', zh).detail, /暂停了/)
  assert.equal(taskLines(task({ status: 'completed' }), now, 'UTC', zh).mark, 'offline')
})

test('运行记录一行：状态、时间、触发、合并；错误优先于摘要', async () => {
  const { runLines, errorText } = await import('../src/screens/tasks/lines.ts')
  const now = Date.UTC(2026, 9, 19, 12, 0)
  const ok = runLines(
    run({ startedAt: Date.UTC(2026, 9, 19, 9, 0), coalesced: 3, summary: '写好了', read: false }),
    now,
    zh,
  )
  // 时间按手机所在的时区说，这里只看别的几段
  assert.match(ok.title, /^成功 · .+ · 按日程 · 合并了 3 次错过的$/)
  assert.equal(ok.detail, '写好了')
  assert.equal(ok.mark, 'unread')
  const bad = runLines(
    run({
      status: 'failed',
      trigger: 'manual',
      error: { code: 'cwdMissing', message: '' },
      summary: 'x',
    }),
    now,
    zh,
  )
  assert.match(bad.title, /手动运行/)
  assert.equal(bad.detail, '工作目录不存在')
  assert.equal(bad.mark, 'error')
  assert.equal(
    errorText({ code: 'internal', message: 'disk full' }, en),
    'Internal error in the device service: disk full',
  )
})

test('英文的运行记录行首字母大写', async () => {
  const { runLines } = await import('../src/screens/tasks/lines.ts')
  assert.match(runLines(run({ status: 'failed' }), Date.now(), en).title, /^Failed · /)
})
