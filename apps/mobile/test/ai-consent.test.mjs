import assert from 'node:assert/strict'
import { test } from 'node:test'
import { consentChannel, needsAIConsent } from '../src/privacy/consent.ts'
import { createConsentAccess } from '../src/privacy/consent-access.ts'

const commands = [
  'session.create',
  'session.send',
  'session.edit',
  'session.steer',
  'session.resumeQueue',
  'session.compact',
  'session.implementPlan',
  'session.goal.set',
  'session.recover',
  'session.respond',
  'session.spawn',
  'session.proposal.accept',
  'session.proposal.answer',
  'session.proposal.here',
  'session.queuedNotes.deliver',
  'session.sideChat',
  'files.uploadAttachment',
  'managers.create',
  'managers.update',
  'managers.reset',
  'managers.answers.submit',
  'managers.feedback.submit',
  'managers.question.ask',
  'managers.question.forward',
  'managers.post.question',
  'managers.post.forward',
  'tasks.create',
  'tasks.update',
  'tasks.runNow',
]
function fixture(initial = null, platform = 'ios') {
  let saved = initial
  const records = {
    read: () => structuredClone(saved),
    write: (value) => {
      saved = structuredClone(value)
    },
    remove: () => {
      saved = null
    },
  }
  const access = createConsentAccess(records)
  const sent = []
  const base = {
    command: async (...args) => {
      sent.push(args)
      return 'sent'
    },
    subscribe: () => () => {},
    close() {},
  }
  const channel = consentChannel(base, access, () => 'Review and agree; draft kept', platform)
  return { records, access, sent, base, channel }
}

test('iOS 首次启动即告知；未同意时所有发送入口明确拒绝且不传出内容', async () => {
  const f = fixture()
  f.access.launch('ios')
  assert.equal(f.access.current(), 'notice')
  f.access.answer(false)
  for (const name of commands) {
    assert.equal(needsAIConsent(name), true, name)
    const draft = { text: 'private draft', deviceId: 'd1' }
    await assert.rejects(
      f.channel.command(name, draft),
      (error) => error.code === 'rejected' && error.message.includes('draft kept'),
    )
    assert.equal(f.access.current(), 'required')
    assert.equal(draft.text, 'private draft')
    f.access.close()
  }
  assert.deepEqual(f.sent, [])
})

test('启动同意后连续发送、插话、排队、换设备或供应商均不再询问', async () => {
  const f = fixture()
  f.access.launch('ios')
  f.access.answer(true)
  for (const [i, name] of commands.entries()) {
    await f.channel.command(name, {
      deviceId: `d${i}`,
      harness: `h${i}`,
      model: `provider${i}/model`,
      now: i % 2 === 0,
    })
    assert.equal(f.access.current(), null)
  }
  assert.equal(f.sent.length, commands.length)
  // 冷启动/升级使用同一个文件，不以版本或当前服务配置决定是否重问。
  const restarted = fixture(f.records.read())
  restarted.access.launch('ios')
  assert.equal(restarted.access.current(), null)
  await restarted.channel.command('session.send', { text: 'after upgrade' })
  assert.equal(restarted.sent.length, 1)
})

test('不同意跨重启记住；去同意不会自动重放发送，撤回立即阻止后续发送', async () => {
  const f = fixture()
  f.access.answer(false)
  const next = fixture(f.records.read())
  next.access.launch('ios')
  assert.equal(next.access.current(), null)
  await assert.rejects(next.channel.command('session.send', { text: 'draft' }), {
    code: 'rejected',
  })
  next.access.open()
  assert.equal(next.access.current(), 'notice')
  next.access.answer(true)
  assert.deepEqual(next.sent, [])
  await next.channel.command('session.send', { text: 'draft' })
  next.access.withdraw()
  await assert.rejects(next.channel.command('session.send', {}), { code: 'rejected' })
  assert.equal(next.sent.length, 1)
  const restarted = fixture(next.records.read())
  restarted.access.launch('ios')
  assert.equal(restarted.access.current(), null)
  assert.equal(restarted.access.allowed(), false)
})

test('沿用旧版真实许可，包括未知供应商；空记录或损坏记录不算同意', () => {
  for (const provider of ['anthropic', 'unreported']) {
    const f = fixture({ [JSON.stringify(['d1', 'claude-code', provider])]: 'revision' })
    f.access.launch('ios')
    assert.equal(f.access.allowed(), true)
    assert.equal(f.access.current(), null)
    assert.ok(f.records.read()[JSON.stringify(['d1', 'claude-code', provider])])
  }
  for (const saved of [
    null,
    {},
    [],
    'invalid',
    { nonsense: 'v1' },
    { '["d","h","p"]': '' },
    { '["d","h","attachment-upload"]': 'v1' },
  ]) {
    const f = fixture(saved)
    f.access.launch('ios')
    assert.equal(f.access.allowed(), false)
    assert.equal(f.access.current(), 'notice')
  }
})

test('Android 所有发送入口沿用原通道；同意记录、浮层和键盘路径均不参与', async () => {
  const f = fixture(null, 'android')
  assert.equal(f.channel, f.base)
  f.access.launch('android')
  for (const name of commands) await f.channel.command(name, { text: 'draft' })
  assert.equal(f.sent.length, commands.length)
  assert.equal(f.access.current(), null)
  assert.equal(f.records.read(), null)
})

test('切后台、浮层承载点卸载及服务重建不取消已允许的在途命令', async () => {
  const f = fixture()
  f.access.answer(true)
  let finish
  const base = {
    ...f.base,
    command: () =>
      new Promise((done) => {
        finish = done
      }),
  }
  const channel = consentChannel(base, f.access, () => 'required', 'ios')
  const sent = channel.command('session.send', {})
  f.access.close()
  f.access.launch('ios')
  const recreated = consentChannel(base, f.access, () => 'required', 'ios')
  f.access.withdraw()
  finish('delivered')
  assert.equal(await sent, 'delivered')
  await assert.rejects(recreated.command('session.send', {}), { code: 'rejected' })
})

test('并发未同意请求立即结束；任何弹框答复都不返回 cancelled', async () => {
  const f = fixture()
  const results = await Promise.allSettled([
    f.channel.command('session.send', { text: 'one' }),
    f.channel.command('managers.post.question', { text: 'two' }),
  ])
  assert.ok(results.every((r) => r.status === 'rejected' && r.reason.code === 'rejected'))
  f.access.open()
  f.access.answer(false)
  assert.deepEqual(f.sent, [])
})

test('读、停止与暂停不要求同意；启用定时任务与模型设置仍守出口', async () => {
  const f = fixture()
  for (const name of ['session.interrupt', 'files.read']) await f.channel.command(name, {})
  assert.equal(f.sent.length, 2)
  assert.equal(f.access.current(), null)
  assert.equal(needsAIConsent('session.configure', { settings: { model: 'model' } }), true)
  assert.equal(
    needsAIConsent('session.configure', { settings: { permission: 'read-only' } }),
    false,
  )
  assert.equal(needsAIConsent('tasks.pause', { paused: false }), true)
  assert.equal(needsAIConsent('tasks.pause', { paused: true }), false)
})

test('写盘失败不能假装同意成功；订阅清理不会取消许可或发送', () => {
  const records = {
    read: () => null,
    write: () => {
      throw new Error('disk full')
    },
  }
  const access = createConsentAccess(records)
  let updates = 0
  const stop = access.subscribe(() => updates++)
  access.launch('ios')
  assert.throws(() => access.answer(true), /disk full/)
  assert.equal(access.allowed(), false)
  assert.equal(access.current(), 'notice')
  stop()
  stop()
  access.close()
  assert.equal(updates, 1)
})
