import assert from 'node:assert/strict'
import test from 'node:test'
import { questionAge } from '../src/composer/question-age.ts'
import { requestLabel } from '../src/composer/request-label.ts'
import { translate } from '../src/i18n/index.ts'

const now = 1_700_000_000_000
const t = (lang) => (key, args) => translate(lang, key, args)

test('待答时间按刚刚、分钟、小时、天分档；未来时间归刚刚，未知不造时间', () => {
  for (const [minutes, key, count] of [
    [0, 'ask.ageNow', 0],
    [0.9, 'ask.ageNow', 0],
    [1, 'ask.age', 1],
    [59, 'ask.age', 59],
    [60, 'ask.ageHours', 1],
    [120, 'ask.ageHours', 2],
    [1439, 'ask.ageHours', 23],
    [1440, 'ask.ageDays', 1],
    [2880, 'ask.ageDays', 2],
    [-1, 'ask.ageNow', 0],
  ])
    assert.deepEqual(questionAge(now - minutes * 60_000, now), { key, count })
  assert.deepEqual(questionAge(null, now), { key: 'ask.ageUnknown', count: 0 })
})

test('英文时长与回报数的单复数、中英文登录审批标签', () => {
  assert.equal(t('en')('ask.ageHours', { count: 1 }), 'Asked 1 hour ago')
  assert.equal(t('en')('ask.ageHours', { count: 2 }), 'Asked 2 hours ago')
  assert.equal(t('en')('ask.ageDays', { count: 1 }), 'Asked 1 day ago')
  assert.equal(t('en')('ask.ageDays', { count: 2 }), 'Asked 2 days ago')
  assert.equal(t('en')('ask.reportsAfter', { count: 1 }), '1 update since')
  assert.equal(t('en')('ask.reportsAfter', { count: 2 }), '2 updates since')
  assert.equal(
    requestLabel({ kind: 'clientApproval', title: ' GitHub ' }, t('zh-CN')),
    '登录 GitHub',
  )
  assert.equal(requestLabel({ kind: 'clientApproval', title: ' ' }, t('zh-CN')), '浏览器登录')
  assert.equal(requestLabel({ kind: 'clientApproval', title: '' }, t('en')), 'Browser sign-in')
  assert.equal(requestLabel(undefined, t('en')), 'Pending request')
  assert.equal(requestLabel({ kind: 'question', title: '范围？' }, t('zh-CN')), '范围？')
})
