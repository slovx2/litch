// 定时任务的日程计算（packages/protocol/src/task-schedule.mts）：校验、下一次、错过了几次。
// 设备进程按它排日程、客户端按它预览，夏令时、月末、最小间隔都在这里钉住。
// 期望值都写成带偏移的时刻（比如 2026-03-08T03:30-04:00），一眼看得出是哪个墙钟、哪个偏移。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { TaskSchedule } from '../../protocol/src/device-tasks.mjs'
import {
  countTaskRuns,
  isTaskTimeZone,
  localTaskTimeZone,
  MIN_TASK_INTERVAL_MINUTES,
  nextTaskRun,
  validateTaskSchedule,
} from '../../protocol/src/task-schedule.mjs'

/** 带偏移的 ISO 时刻 → Unix 秒 */
function at(iso: string): number {
  const ms = Date.parse(iso)
  assert.ok(Number.isFinite(ms), `写错了时刻：${iso}`)
  return ms / 1000
}

/** 从 after 起连着取几次 */
function runs(
  schedule: TaskSchedule,
  zone: string,
  after: number,
  n: number,
  anchor = 0,
): number[] {
  const out: number[] = []
  let cursor = after
  for (let i = 0; i < n; i++) {
    const next = nextTaskRun(schedule, zone, cursor, anchor)
    if (next === null) break
    out.push(next)
    cursor = next
  }
  return out
}

function iso(list: string[]): number[] {
  return list.map(at)
}

// ---------- 时区 ----------

test('认得 IANA 时区名，不认偏移写法和瞎写的', () => {
  for (const zone of [
    'UTC',
    'Asia/Shanghai',
    'America/New_York',
    'Europe/London',
    'Australia/Lord_Howe',
    'America/Argentina/Buenos_Aires',
    'Etc/GMT+8',
  ])
    assert.equal(isTaskTimeZone(zone), true, zone)
  for (const zone of [
    '',
    'Mars/Phobos',
    '+08:00',
    'UTC+8',
    ' Asia/Shanghai',
    'Asia/Shanghai/',
    '../x',
  ])
    assert.equal(isTaskTimeZone(zone), false, zone)
})

test('本机时区跟着 TZ 走，认不出来是 UTC', () => {
  const saved = process.env.TZ
  try {
    process.env.TZ = 'America/New_York'
    assert.equal(localTaskTimeZone(), 'America/New_York')
    process.env.TZ = 'Asia/Shanghai'
    assert.equal(localTaskTimeZone(), 'Asia/Shanghai')
  } finally {
    if (saved === undefined) delete process.env.TZ
    else process.env.TZ = saved
  }
  assert.equal(isTaskTimeZone(localTaskTimeZone()), true)
})

// ---------- 校验 ----------

test('每种日程的合法写法都过', () => {
  const ok: unknown[] = [
    { type: 'once', at: '2028-02-29T23:59' },
    { type: 'interval', minutes: MIN_TASK_INTERVAL_MINUTES },
    { type: 'interval', minutes: 1440 },
    { type: 'hourly', intervalHours: 1, minute: 0, days: null },
    { type: 'hourly', intervalHours: 23, minute: 59, days: ['MO', 'SU'] },
    { type: 'daily', time: '00:00' },
    { type: 'weekdays', time: '23:59' },
    { type: 'weekly', days: ['SA'], time: '09:30' },
    { type: 'monthly', day: 31, time: '12:00' },
  ]
  for (const schedule of ok) assert.equal(validateTaskSchedule(schedule, 'Asia/Shanghai'), null)
})

test('不合法的形状、范围、日期都指出字段', () => {
  const cases: [unknown, unknown, string][] = [
    [null, 'UTC', 'schedule'],
    [[], 'UTC', 'schedule'],
    ['daily', 'UTC', 'schedule'],
    [{}, 'UTC', 'schedule.type'],
    [{ type: 'yearly' }, 'UTC', 'schedule.type'],
    [{ type: 'toString', time: '09:00' }, 'UTC', 'schedule.type'],
    [{ type: 'daily' }, 'UTC', 'schedule.time'],
    [{ type: 'daily', time: '09:00', days: null }, 'UTC', 'schedule.days'],
    [{ type: 'daily', time: '9:30' }, 'UTC', 'schedule.time'],
    [{ type: 'daily', time: '24:00' }, 'UTC', 'schedule.time'],
    [{ type: 'weekdays', time: '09:60' }, 'UTC', 'schedule.time'],
    [{ type: 'daily', time: 930 }, 'UTC', 'schedule.time'],
    [{ type: 'weekly', days: [], time: '09:00' }, 'UTC', 'schedule.days'],
    [{ type: 'weekly', days: ['MO', 'MO'], time: '09:00' }, 'UTC', 'schedule.days'],
    [{ type: 'weekly', days: ['mo'], time: '09:00' }, 'UTC', 'schedule.days'],
    [{ type: 'weekly', days: 'MO', time: '09:00' }, 'UTC', 'schedule.days'],
    [{ type: 'weekly', days: null, time: '09:00' }, 'UTC', 'schedule.days'],
    [{ type: 'weekly', days: ['MO'], time: '25:00' }, 'UTC', 'schedule.time'],
    [{ type: 'hourly', intervalHours: 0, minute: 0, days: null }, 'UTC', 'schedule.intervalHours'],
    [{ type: 'hourly', intervalHours: 24, minute: 0, days: null }, 'UTC', 'schedule.intervalHours'],
    [
      { type: 'hourly', intervalHours: 1.5, minute: 0, days: null },
      'UTC',
      'schedule.intervalHours',
    ],
    [{ type: 'hourly', intervalHours: 2, minute: 60, days: null }, 'UTC', 'schedule.minute'],
    [{ type: 'hourly', intervalHours: 2, minute: -1, days: null }, 'UTC', 'schedule.minute'],
    [{ type: 'hourly', intervalHours: 2, minute: 0 }, 'UTC', 'schedule.days'],
    [{ type: 'hourly', intervalHours: 2, minute: 0, days: [] }, 'UTC', 'schedule.days'],
    [{ type: 'monthly', day: 0, time: '09:00' }, 'UTC', 'schedule.day'],
    [{ type: 'monthly', day: 32, time: '09:00' }, 'UTC', 'schedule.day'],
    [{ type: 'monthly', day: '1', time: '09:00' }, 'UTC', 'schedule.day'],
    [{ type: 'interval', minutes: 4 }, 'UTC', 'schedule.minutes'],
    [{ type: 'interval', minutes: 5.5 }, 'UTC', 'schedule.minutes'],
    [{ type: 'interval', minutes: '10' }, 'UTC', 'schedule.minutes'],
    [{ type: 'interval', minutes: Number.NaN }, 'UTC', 'schedule.minutes'],
    [{ type: 'interval', minutes: Number.POSITIVE_INFINITY }, 'UTC', 'schedule.minutes'],
    [{ type: 'once', at: '2026-02-29T09:00' }, 'UTC', 'schedule.at'],
    [{ type: 'once', at: '2026-04-31T09:00' }, 'UTC', 'schedule.at'],
    [{ type: 'once', at: '2026-13-01T09:00' }, 'UTC', 'schedule.at'],
    [{ type: 'once', at: '2026-00-10T09:00' }, 'UTC', 'schedule.at'],
    [{ type: 'once', at: '2026-10-20 09:30' }, 'UTC', 'schedule.at'],
    [{ type: 'once', at: '2026-10-20T09:30:00' }, 'UTC', 'schedule.at'],
    [{ type: 'once', at: '2026-10-20T09:30Z' }, 'UTC', 'schedule.at'],
    [{ type: 'once', at: 1_800_000_000 }, 'UTC', 'schedule.at'],
    [{ type: 'daily', time: '09:00' }, 'Mars/Base', 'timezone'],
    [{ type: 'daily', time: '09:00' }, '+08:00', 'timezone'],
    [{ type: 'daily', time: '09:00' }, null, 'timezone'],
    [{ type: 'daily', time: '09:00' }, 8, 'timezone'],
  ]
  for (const [schedule, zone, field] of cases) {
    const found = validateTaskSchedule(schedule, zone)
    assert.equal(found?.field, field, JSON.stringify(schedule))
    assert.match(found?.message ?? '', /^[\x20-\x7e]+$/, '说明是英文的一句话')
  }
})

// ---------- interval ----------

test('interval 从 anchor 起每隔 minutes，anchor 本身不算', () => {
  const schedule: TaskSchedule = { type: 'interval', minutes: 30 }
  const anchor = at('2026-10-19T10:00:20+08:00')
  assert.deepEqual(
    runs(schedule, 'Asia/Shanghai', anchor, 3, anchor),
    iso(['2026-10-19T10:30:20+08:00', '2026-10-19T11:00:20+08:00', '2026-10-19T11:30:20+08:00']),
  )
  // after 早于 anchor 时也从 anchor 往后数
  assert.equal(nextTaskRun(schedule, 'UTC', anchor - 86_400, anchor), anchor + 1800)
  // 正好落在一个点上要的是下一个
  assert.equal(nextTaskRun(schedule, 'UTC', anchor + 3600, anchor), anchor + 5400)
  assert.equal(nextTaskRun(schedule, 'UTC', anchor + 3599, anchor), anchor + 3600)
})

test('interval 不看时区，夏令时那天照样等距', () => {
  const schedule: TaskSchedule = { type: 'interval', minutes: 60 }
  const anchor = at('2026-03-08T00:30-05:00')
  const list = runs(schedule, 'America/New_York', anchor, 4, anchor)
  assert.deepEqual(
    list.map((t, i) => t - (list[i - 1] ?? anchor)),
    [3600, 3600, 3600, 3600],
  )
})

test('interval 错过一年的 5 分钟也是直接算出来', () => {
  const schedule: TaskSchedule = { type: 'interval', minutes: 5 }
  const anchor = at('2025-10-19T00:00Z')
  const now = at('2026-10-19T00:00Z')
  const started = performance.now()
  assert.equal(countTaskRuns(schedule, 'UTC', anchor, now, anchor), 1000)
  assert.equal(countTaskRuns(schedule, 'UTC', anchor, now, anchor, 1_000_000), 365 * 288)
  assert.ok(performance.now() - started < 5, '应该是算出来的，不是一个个数出来的')
  // (from, to]：左开右闭
  assert.equal(countTaskRuns(schedule, 'UTC', anchor + 300, anchor + 900, anchor), 2)
  assert.equal(countTaskRuns(schedule, 'UTC', anchor + 299, anchor + 900, anchor), 3)
  assert.equal(countTaskRuns(schedule, 'UTC', anchor - 600, anchor + 300, anchor), 1)
  assert.equal(countTaskRuns(schedule, 'UTC', anchor + 900, anchor + 900, anchor), 0)
  assert.equal(countTaskRuns(schedule, 'UTC', anchor, now, anchor, 0), 0)
})

// ---------- once ----------

test('once 按任务时区换算，过了或早于 anchor 就没有下一次', () => {
  const schedule: TaskSchedule = { type: 'once', at: '2026-10-20T09:30' }
  const time = at('2026-10-20T09:30+08:00')
  const created = at('2026-10-19T12:00+08:00')
  assert.equal(nextTaskRun(schedule, 'Asia/Shanghai', created, created), time)
  assert.equal(nextTaskRun(schedule, 'Asia/Shanghai', time - 1, created), time)
  assert.equal(nextTaskRun(schedule, 'Asia/Shanghai', time, created), null)
  assert.equal(nextTaskRun(schedule, 'Asia/Shanghai', time + 3600, created), null)
  // 建的时候时间已经过了
  assert.equal(nextTaskRun(schedule, 'Asia/Shanghai', 0, time + 1), null)
  assert.equal(nextTaskRun(schedule, 'UTC', created, created), at('2026-10-20T09:30Z'))
  // 错过了数得出来（设备拿它决定补跑）
  assert.equal(countTaskRuns(schedule, 'Asia/Shanghai', created, time + 86_400, created), 1)
  assert.equal(countTaskRuns(schedule, 'Asia/Shanghai', time, time + 86_400, created), 0)
  assert.equal(countTaskRuns(schedule, 'Asia/Shanghai', created, time + 86_400, time + 1), 0)
})

test('once 落在夏令时跳过的时刻顺延，重复的时刻取第一次', () => {
  const zone = 'America/New_York'
  assert.equal(
    nextTaskRun({ type: 'once', at: '2026-03-08T02:30' }, zone, 0, 0),
    at('2026-03-08T03:30-04:00'),
  )
  assert.equal(
    nextTaskRun({ type: 'once', at: '2026-11-01T01:30' }, zone, 0, 0),
    at('2026-11-01T01:30-04:00'),
  )
})

// ---------- daily、weekdays、weekly ----------

test('daily 在上海、UTC 每天同一墙钟', () => {
  const schedule: TaskSchedule = { type: 'daily', time: '09:00' }
  assert.deepEqual(
    runs(schedule, 'Asia/Shanghai', at('2026-10-19T09:00+08:00'), 3),
    iso(['2026-10-20T09:00+08:00', '2026-10-21T09:00+08:00', '2026-10-22T09:00+08:00']),
  )
  assert.deepEqual(
    runs(schedule, 'UTC', at('2026-12-31T08:59Z'), 2),
    iso(['2026-12-31T09:00Z', '2027-01-01T09:00Z']),
  )
})

test('daily 遇到纽约春秋两次夏令时切换', () => {
  const zone = 'America/New_York'
  // 02:30 在 3 月 8 日不存在，顺延到 03:30（EDT）
  assert.deepEqual(
    runs({ type: 'daily', time: '02:30' }, zone, at('2026-03-06T12:00-05:00'), 3),
    iso(['2026-03-07T02:30-05:00', '2026-03-08T03:30-04:00', '2026-03-09T02:30-04:00']),
  )
  // 01:30 在 11 月 1 日有两次，只算第一次（EDT）
  assert.deepEqual(
    runs({ type: 'daily', time: '01:30' }, zone, at('2026-10-30T12:00-04:00'), 3),
    iso(['2026-10-31T01:30-04:00', '2026-11-01T01:30-04:00', '2026-11-02T01:30-05:00']),
  )
  // 切换前后的整段里数得对
  assert.equal(
    countTaskRuns(
      { type: 'daily', time: '01:30' },
      zone,
      at('2026-10-25T00:00-04:00'),
      at('2026-11-08T00:00-05:00'),
      0,
    ),
    14,
  )
})

test('daily 遇到伦敦的夏令时切换', () => {
  const zone = 'Europe/London'
  assert.equal(
    nextTaskRun({ type: 'daily', time: '01:30' }, zone, at('2026-03-28T12:00Z'), 0),
    at('2026-03-29T02:30+01:00'),
  )
  assert.equal(
    nextTaskRun({ type: 'daily', time: '01:30' }, zone, at('2026-10-24T12:00+01:00'), 0),
    at('2026-10-25T01:30+01:00'),
  )
  assert.equal(
    nextTaskRun({ type: 'daily', time: '01:30' }, zone, at('2026-10-25T01:30+01:00'), 0),
    at('2026-10-26T01:30Z'),
  )
})

test('daily 遇到豪勋爵岛半小时的夏令时', () => {
  const zone = 'Australia/Lord_Howe'
  // 10 月 4 日 02:00 拨到 02:30，02:15 顺延半小时
  assert.deepEqual(
    runs({ type: 'daily', time: '02:15' }, zone, at('2026-10-03T12:00+10:30'), 2),
    iso(['2026-10-04T02:45+11:00', '2026-10-05T02:15+11:00']),
  )
  // 4 月 5 日 02:00 拨回 01:30，01:45 有两次，取第一次
  assert.deepEqual(
    runs({ type: 'daily', time: '01:45' }, zone, at('2026-04-04T12:00+11:00'), 2),
    iso(['2026-04-05T01:45+11:00', '2026-04-06T01:45+10:30']),
  )
})

test('weekdays 跳过周末', () => {
  // 2026-10-23 是星期五
  assert.deepEqual(
    runs({ type: 'weekdays', time: '18:00' }, 'Asia/Shanghai', at('2026-10-23T17:00+08:00'), 3),
    iso(['2026-10-23T18:00+08:00', '2026-10-26T18:00+08:00', '2026-10-27T18:00+08:00']),
  )
})

test('weekly 只在列出的几天，按任务时区认星期', () => {
  const schedule: TaskSchedule = { type: 'weekly', days: ['SU', 'WE'], time: '00:30' }
  // 2026-10-21 是星期三；上海的星期三 00:30 在 UTC 还是星期二
  assert.deepEqual(
    runs(schedule, 'Asia/Shanghai', at('2026-10-19T00:00+08:00'), 3),
    iso(['2026-10-21T00:30+08:00', '2026-10-25T00:30+08:00', '2026-10-28T00:30+08:00']),
  )
  assert.equal(
    countTaskRuns(
      schedule,
      'Asia/Shanghai',
      at('2026-10-01T00:00+08:00'),
      at('2026-11-01T00:00+08:00'),
      0,
    ),
    8,
  )
})

// ---------- hourly ----------

test('hourly 从当天 0 点起按间隔数，跨天重新从 0 点数', () => {
  const schedule: TaskSchedule = { type: 'hourly', intervalHours: 5, minute: 10, days: null }
  assert.deepEqual(
    runs(schedule, 'Asia/Shanghai', at('2026-10-19T14:00+08:00'), 4),
    iso([
      '2026-10-19T15:10+08:00',
      '2026-10-19T20:10+08:00',
      '2026-10-20T00:10+08:00',
      '2026-10-20T05:10+08:00',
    ]),
  )
})

test('hourly 的 days 限定星期', () => {
  // 2026-10-19 是星期一
  const schedule: TaskSchedule = {
    type: 'hourly',
    intervalHours: 12,
    minute: 0,
    days: ['MO', 'TH'],
  }
  assert.deepEqual(
    runs(schedule, 'UTC', at('2026-10-19T00:00Z'), 4),
    iso(['2026-10-19T12:00Z', '2026-10-22T00:00Z', '2026-10-22T12:00Z', '2026-10-26T00:00Z']),
  )
})

test('hourly 遇到纽约夏令时：顺延撞上下一次的只算一次，重复的小时只算第一次', () => {
  const zone = 'America/New_York'
  const schedule: TaskSchedule = { type: 'hourly', intervalHours: 1, minute: 30, days: null }
  // 3 月 8 日 02:30 顺延到 03:30，和本来的 03:30 是同一刻，只跑一次：这天 23 次
  assert.deepEqual(
    runs(schedule, zone, at('2026-03-08T00:00-05:00'), 4),
    iso([
      '2026-03-08T00:30-05:00',
      '2026-03-08T01:30-05:00',
      '2026-03-08T03:30-04:00',
      '2026-03-08T04:30-04:00',
    ]),
  )
  assert.equal(
    countTaskRuns(schedule, zone, at('2026-03-08T00:00-05:00'), at('2026-03-09T00:00-04:00'), 0),
    23,
  )
  // 11 月 1 日 01:30 只算 EDT 那次，下一次是 EST 的 02:30：这天 24 次（25 个小时）
  assert.deepEqual(
    runs(schedule, zone, at('2026-11-01T01:00-04:00'), 2),
    iso(['2026-11-01T01:30-04:00', '2026-11-01T02:30-05:00']),
  )
  assert.equal(
    countTaskRuns(schedule, zone, at('2026-11-01T00:00-04:00'), at('2026-11-02T00:00-05:00'), 0),
    24,
  )
})

test('hourly 遇到豪勋爵岛半小时的夏令时，间隔仍不小于最小间隔', () => {
  const schedule: TaskSchedule = { type: 'hourly', intervalHours: 1, minute: 15, days: null }
  const list = runs(schedule, 'Australia/Lord_Howe', at('2026-10-04T00:30+10:30'), 4)
  assert.deepEqual(
    list,
    iso([
      '2026-10-04T01:15+10:30',
      '2026-10-04T02:45+11:00',
      '2026-10-04T03:15+11:00',
      '2026-10-04T04:15+11:00',
    ]),
  )
  for (let i = 1; i < list.length; i++)
    assert.ok((list[i] ?? 0) - (list[i - 1] ?? 0) >= MIN_TASK_INTERVAL_MINUTES * 60)
})

// ---------- monthly ----------

test('monthly 31 号：没有 31 号的月份在最后一天跑，闰年 2 月是 29 号', () => {
  const schedule: TaskSchedule = { type: 'monthly', day: 31, time: '08:00' }
  assert.deepEqual(
    runs(schedule, 'Asia/Shanghai', at('2028-01-01T00:00+08:00'), 5),
    iso([
      '2028-01-31T08:00+08:00',
      '2028-02-29T08:00+08:00',
      '2028-03-31T08:00+08:00',
      '2028-04-30T08:00+08:00',
      '2028-05-31T08:00+08:00',
    ]),
  )
  assert.equal(
    countTaskRuns(
      schedule,
      'Asia/Shanghai',
      at('2027-01-01T00:00+08:00'),
      at('2028-01-01T00:00+08:00'),
      0,
    ),
    12,
  )
})

test('monthly 29 号：平年 2 月是 28 号，闰年是 29 号', () => {
  const schedule: TaskSchedule = { type: 'monthly', day: 29, time: '23:30' }
  assert.equal(nextTaskRun(schedule, 'UTC', at('2027-02-01T00:00Z'), 0), at('2027-02-28T23:30Z'))
  assert.equal(nextTaskRun(schedule, 'UTC', at('2028-02-01T00:00Z'), 0), at('2028-02-29T23:30Z'))
  assert.equal(nextTaskRun(schedule, 'UTC', at('2028-02-29T23:30Z'), 0), at('2028-03-29T23:30Z'))
})

test('monthly 按任务时区认日子：纽约的 1 号还是 UTC 的 1 号', () => {
  const schedule: TaskSchedule = { type: 'monthly', day: 1, time: '21:00' }
  assert.equal(
    nextTaskRun(schedule, 'America/New_York', at('2026-10-15T00:00Z'), 0),
    at('2026-11-01T21:00-05:00'),
  )
})

// ---------- anchor、limit ----------

test('日历日程不早于 anchor', () => {
  const schedule: TaskSchedule = { type: 'daily', time: '09:00' }
  const created = at('2026-10-19T09:00:30+08:00')
  // 建的时候当天 09:00 刚过，下一次是明天
  assert.equal(
    nextTaskRun(schedule, 'Asia/Shanghai', created, created),
    at('2026-10-20T09:00+08:00'),
  )
  // after 远早于 anchor 时也从 anchor 起
  assert.equal(nextTaskRun(schedule, 'Asia/Shanghai', 0, created), at('2026-10-20T09:00+08:00'))
  const exact = at('2026-10-20T09:00+08:00')
  assert.equal(nextTaskRun(schedule, 'Asia/Shanghai', exact - 1, exact), exact)
  assert.equal(
    countTaskRuns(schedule, 'Asia/Shanghai', 0, at('2026-10-22T12:00+08:00'), created),
    3,
  )
})

test('日历日程错过很久时数到 limit 就停', () => {
  const schedule: TaskSchedule = { type: 'hourly', intervalHours: 1, minute: 0, days: null }
  const from = at('2025-10-19T00:00Z')
  const to = at('2026-10-19T00:00Z')
  const started = performance.now()
  assert.equal(countTaskRuns(schedule, 'Europe/London', from, to, 0), 1000)
  assert.equal(countTaskRuns(schedule, 'Europe/London', from, to, 0, 10), 10)
  assert.ok(performance.now() - started < 1000)
  // 一年的 daily 不到 limit，数完：365 次
  assert.equal(countTaskRuns({ type: 'daily', time: '07:00' }, 'Europe/London', from, to, 0), 365)
  assert.equal(countTaskRuns({ type: 'daily', time: '07:00' }, 'Europe/London', to, from, 0), 0)
})
