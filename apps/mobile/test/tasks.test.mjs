// 定时任务里手机自己的那几样：时刻的写法整理、数字栏（src/screens/tasks/time.ts），任务和运行记录的行（lines.ts），
// 文案键。日程描述、表单互转、校验、预览是桌面界面那一份（packages/ui/src/tasks/），单测在 packages/ui/test/tasks-logic.test.mjs。
// 翻译函数照 src/ui/i18n.ts 的做法拼：手机的键先找手机那一份，别的交给桌面界面的 translate（不经 i18n.ts：它要 React 和 expo）。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { translate } from '../../../packages/ui/src/i18n/index.ts'
import { zhCN as desktop } from '../../../packages/ui/src/i18n/zh-CN.ts'
import { runLines, taskLines } from '../src/screens/tasks/lines.ts'
import { numberOf, textOf, tidyTime } from '../src/screens/tasks/time.ts'
import * as messages from '../src/ui/messages/tasks.ts'

function tr(lang) {
  const mobile = lang === 'en' ? messages.en : messages.zhCN
  const t = (key, args = {}) => {
    const entry = mobile[key]
    if (entry === undefined) return translate(lang, key, args)
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

test('时刻的写法整理成 HH:MM', () => {
  assert.equal(tidyTime('9'), '09:00')
  assert.equal(tidyTime('9:05'), '09:05')
  assert.equal(tidyTime('9:5'), '09:05')
  assert.equal(tidyTime('930'), '09:30')
  assert.equal(tidyTime('0930'), '09:30')
  assert.equal(tidyTime(' 23:59 '), '23:59')
  assert.equal(tidyTime('24:00'), null)
  assert.equal(tidyTime('12:60'), null)
  assert.equal(tidyTime('abc'), null)
})

test('数字栏的字和数：空着、带小数点、带字母的都是 NaN', () => {
  assert.equal(numberOf('15'), 15)
  assert.equal(numberOf(' 7 '), 7)
  assert.ok(Number.isNaN(numberOf('')))
  assert.ok(Number.isNaN(numberOf('1.5')))
  assert.ok(Number.isNaN(numberOf('5m')))
  assert.equal(textOf(Number.NaN), '')
  assert.equal(textOf(30), '30')
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
  approvals: [],
  ...over,
})

test('任务一行：日程、下一次或状态、最近一次、未读和记号', () => {
  const now = Date.now()
  const plain = taskLines(task({ nextRunAt: now + 3_600_000 }), now, 'UTC', zh)
  assert.equal(plain.title, '日报')
  assert.match(plain.detail, /^每天 09:00\n下次 /)
  assert.equal(plain.meta, undefined)
  assert.equal(plain.mark, 'idle')
  // 任务的时区和看的人不一样：日程后面带上时区名
  assert.match(taskLines(task(), now, 'Asia/Shanghai', zh).detail, /^每天 09:00 · UTC\n/)

  const busy = taskLines(
    task({ lastRun: run({ status: 'running', startedAt: now }) }),
    now,
    'UTC',
    zh,
  )
  assert.equal(busy.mark, 'running')
  assert.match(busy.detail, /上次 运行中 今天 \d\d:\d\d/)

  const failed = taskLines(
    task({ unreadRuns: 2, lastError: { code: 'turnFailed', message: 'boom' } }),
    now,
    'UTC',
    zh,
  )
  assert.equal(failed.mark, 'error')
  assert.equal(failed.meta, '2 次未读')
  assert.equal(taskLines(task({ unreadRuns: 1 }), now, 'UTC', zh).mark, 'unread')
  assert.match(taskLines(task({ status: 'paused' }), now, 'UTC', zh).detail, /已暂停/)
  assert.equal(taskLines(task({ status: 'completed' }), now, 'UTC', zh).mark, 'offline')
})

test('运行记录一行：状态、时间、触发、合并；错误优先于摘要', () => {
  const now = Date.now()
  const ok = runLines(
    run({ startedAt: now, coalesced: 3, summary: '写好了', read: false }),
    now,
    zh,
  )
  assert.match(ok.title, /^成功 · 今天 \d\d:\d\d · 定时 · 合并了 3 次错过的运行$/)
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
  assert.match(bad.title, /^失败 · .+ · 手动$/)
  assert.equal(bad.detail, '工作目录不存在')
  assert.equal(bad.mark, 'error')
  assert.match(runLines(run({ status: 'queued' }), now, en).title, /^Queued · /)
})

test('回合停在审批上：任务和运行都标等你处理，运行的每条审批一行，自动拒绝的说等了多久', () => {
  const now = Date.now()
  const ask = (over) => ({
    requestId: 'r1',
    kind: 'command',
    title: 'rm -rf build',
    requestedAt: now - 60_000,
    declineAt: now + 29 * 60_000,
    state: 'waiting',
    settledAt: null,
    ...over,
  })
  const waiting = run({ status: 'running', startedAt: now, approvals: [ask()] })
  const lines = runLines(waiting, now, zh)
  assert.equal(lines.mark, 'waiting')
  assert.match(lines.title, /· 等你处理$/)
  assert.match(lines.detail, /^命令：rm -rf build · 等你处理，打开会话即可回应；29 分钟后自动拒绝$/)
  const listed = taskLines(task({ lastRun: waiting }), now, 'UTC', zh)
  assert.equal(listed.mark, 'waiting')
  assert.match(listed.detail, /上次 等你处理 今天/)

  const declined = runLines(
    run({
      summary: '跳过了',
      approvals: [
        ask({
          kind: 'fileChange',
          title: '改配置',
          requestedAt: now - 31 * 60_000,
          declineAt: now - 60_000,
          state: 'autoDeclined',
          settledAt: now - 60_000,
        }),
      ],
    }),
    now,
    zh,
  )
  assert.equal(declined.mark, 'idle')
  assert.equal(declined.detail.split('\n')[0], '跳过了')
  assert.match(
    declined.detail.split('\n')[1],
    /^改文件：改配置 · 等了 30 分钟没人处理，今天 \d\d:\d\d 已自动拒绝$/,
  )
})
