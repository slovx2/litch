import assert from 'node:assert/strict'
import { test } from 'node:test'
import { consentChannel, needsAIConsent } from '../src/privacy/consent.ts'

const target = (provider = 'alpha', extra = {}) => ({
  deviceId: 'd1',
  device: 'Test computer',
  harness: 'pi',
  provider,
  label: provider,
  model: `${provider}/model`,
  revision: provider,
  remember: true,
  delegated: false,
  ...extra,
})
const tick = () => new Promise((done) => setImmediate(done))
function fixture(initial = [target()]) {
  let saved = null
  let targets = initial
  let prompt = null
  const sent = []
  const records = {
    read: () => saved,
    write: (v) => {
      saved = v
    },
    remove: () => {
      saved = null
    },
  }
  const gate = consentChannel(
    {
      command: async (...args) => {
        sent.push(args)
        return {}
      },
      subscribe: () => () => {},
      close() {},
    },
    records,
    async () => targets,
    (value) => {
      prompt = value
    },
    () => 'cancelled',
  )
  return {
    ...gate,
    sent,
    records,
    prompt: () => prompt,
    targets: (value) => {
      targets = value
    },
  }
}

test('新建/继续/排队/编辑/经理/附件/定时任务取消均不传出内容', async () => {
  for (const name of [
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
    'files.uploadAttachment',
    'managers.create',
    'managers.update',
    'managers.reset',
    'managers.answers.submit',
    'managers.feedback.submit',
    'managers.post.question',
    'managers.question.forward',
    'tasks.create',
    'tasks.update',
    'tasks.runNow',
  ]) {
    assert.equal(needsAIConsent(name), true, name)
    const f = fixture()
    const result = f.channel.command(name, { deviceId: 'd1', text: 'private' })
    const rejected = assert.rejects(result, /cancelled/)
    await tick()
    assert.deepEqual(f.sent, [])
    f.prompt().answer(false)
    await rejected
    assert.deepEqual(f.sent, [])
    assert.equal(f.records.read(), null)
  }
})

test('同意按设备和供应商保存；服务版本变化、撤回后再问', async () => {
  const f = fixture()
  const first = f.channel.command('session.send', {})
  await tick()
  f.prompt().answer(true)
  await first
  await f.channel.command('session.edit', {})
  assert.equal(f.sent.length, 2)
  for (const next of [
    target('beta'),
    target('beta', { deviceId: 'd2' }),
    target('beta', { deviceId: 'd2', revision: 'changed-endpoint' }),
  ]) {
    f.targets([next])
    const result = f.channel.command('session.send', {})
    await tick()
    assert.ok(f.prompt())
    f.prompt().answer(true)
    await result
  }
  f.records.remove()
  const afterRevoke = f.channel.command('session.send', {})
  await tick()
  assert.ok(f.prompt())
  f.prompt().answer(true)
  await afterRevoke
})

test('未知服务每次明确许可，不沿用上次记录', async () => {
  const f = fixture([target('unreported', { remember: false })])
  for (let i = 0; i < 2; i++) {
    const result = f.channel.command('session.send', {})
    await tick()
    assert.ok(f.prompt())
    f.prompt().answer(true)
    await result
  }
  assert.deepEqual(f.records.read(), {})
})

test('确认期间供应商改变，旧确认不得授权新目标', async () => {
  const f = fixture()
  const result = f.channel.command('session.send', {})
  const rejected = assert.rejects(result, /cancelled/)
  await tick()
  f.targets([target('beta')])
  f.prompt().answer(true)
  await tick()
  assert.equal(f.prompt().targets[0].provider, 'beta')
  assert.deepEqual(f.sent, [])
  f.prompt().answer(false)
  await rejected
})

test('断开或 AbortSignal 取消浮层时不发送，读与停止不要求同意', async () => {
  for (const close of ['dispose', 'abort']) {
    const f = fixture()
    const controller = new AbortController()
    const result = f.channel.command('session.send', {}, { signal: controller.signal })
    const rejected = assert.rejects(result, /cancelled/)
    await tick()
    if (close === 'dispose') f.dispose()
    else controller.abort()
    await rejected
    assert.equal(f.prompt(), null)
    assert.deepEqual(f.sent, [])
  }
  const f = fixture()
  await f.channel.command('session.interrupt', {})
  await f.channel.command('files.read', {})
  assert.equal(f.prompt(), null)
  assert.equal(f.sent.length, 2)
})

test('更换型号与恢复定时任务也受保护；暂停与普通权限设置不触发数据许可', () => {
  assert.equal(needsAIConsent('session.configure', { settings: { model: 'beta/model' } }), true)
  assert.equal(
    needsAIConsent('session.configure', { settings: { permission: 'read-only' } }),
    false,
  )
  assert.equal(needsAIConsent('tasks.pause', { paused: false }), true)
  assert.equal(needsAIConsent('tasks.pause', { paused: true }), false)
})

test('同时发送的第二次操作等第一张同意卡结束，不覆盖或丢失浮层', async () => {
  const f = fixture()
  const first = f.channel.command('session.send', { text: 'one' })
  const rejected = assert.rejects(first, /cancelled/)
  const second = f.channel.command('session.send', { text: 'two' })
  await tick()
  f.prompt().answer(false)
  await rejected
  await tick()
  f.prompt().answer(true)
  await second
  assert.equal(f.sent.length, 1)
  assert.equal(f.sent[0][1].text, 'two')
})
