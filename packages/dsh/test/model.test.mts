import assert from 'node:assert/strict'
import { join } from 'node:path'
import test from 'node:test'
import { DshServer } from '../src/server.mjs'
import { client, isolate, violations } from './client.mjs'

// 带会话设置的应答里，模型和强度报的是这个会话实际会用的。此前没选过模型的新会话报的是空串：
// dsh 的 modelSelection 投影在会话发过请求、或者选过模型之前是空的，这种会话到发请求时用 dsh 当时的默认
//（模型目录里的 default）。用例拿假模型实际收到的请求来对“报的”和“用的”是不是同一个。
// 这些是 dsh 0.2.0-rc.2 的行为：默认不是固定的，任何会话里选一次模型它都跟着变。

const text = (value: string) => [{ type: 'text', text: value, text_elements: [] }]

test('MODEL-DSH-001：会话设置里的模型和强度是实际会用的：没选过的是 dsh 的默认，选了、用了之后跟着变', {
  timeout: 180000,
}, async () => {
  const env = await isolate((body) => [
    { type: 'text', chunks: [body.tools?.length ? '好的。' : 'mock 标题'] },
  ])
  const home = join(env.root, 'home')
  let server = new DshServer(home)
  try {
    let desktop = client(server)
    await desktop.call('initialize', { clientInfo: { name: 'test', version: '0' } })
    const catalog = async () => (await desktop.call('model/list', {})).data
    const preferred = async () => (await catalog()).find((model: any) => model.isDefault)
    // 应答里各处报的模型和强度：要互相一致
    const reported = (reply: any) => {
      assert.equal(reply.collaborationMode.settings.model, reply.model)
      assert.equal(reply.collaborationMode.settings.reasoning_effort, reply.reasoningEffort)
      assert.equal(reply.modelProvider, reply.model.split('/')[0])
      assert.equal(reply.thread.modelProvider, reply.modelProvider)
      return [reply.model, reply.reasoningEffort]
    }
    const resumed = async (threadId: string) =>
      reported(await desktop.call('thread/resume', { threadId }))
    // 发一个回合，返回假模型这一次收到的模型和强度
    const turn = async (threadId: string, extra: object = {}) => {
      const seen = env.model.requests.length
      const started = await desktop.call('turn/start', {
        threadId,
        input: text('说一句'),
        ...extra,
      })
      const done = await desktop.until(
        'turn/completed',
        (params) => params.threadId === threadId && params.turn.id === started.turn.id,
      )
      assert.equal(done.turn.status, 'completed', JSON.stringify(done.turn.error))
      const body = env.model.requests.slice(seen).findLast((request) => request.tools?.length)
      return [body.model, body.output_config?.effort]
    }

    const first = await preferred()
    const other = (await catalog()).find((model: any) => !model.isDefault)
    assert.ok(first && other, '前提：dsh 的模型目录里有默认的和别的模型')
    const usual = [first.id, first.defaultReasoningEffort]
    const bare = (id: string) => id.slice(id.indexOf('/') + 1)

    // 没指定模型：报的是 dsh 的默认，和 model/list 里 isDefault 的那一项一致
    const plain = await desktop.call('thread/start', { cwd: env.cwd })
    assert.deepEqual(reported(plain), usual)
    assert.deepEqual(await resumed(plain.thread.id), usual)
    const read = await desktop.call('thread/read', { threadId: plain.thread.id })
    assert.equal(read.thread.modelProvider, first.id.split('/')[0])
    // 实际用的就是报的那个；用过之后还是它
    assert.deepEqual(await turn(plain.thread.id), [bare(first.id), first.defaultReasoningEffort])
    assert.deepEqual(await resumed(plain.thread.id), usual)

    // 只改强度、不带模型（界面上只动了强度）：模型还是那个默认，强度是改的
    const tuned = await desktop.call('thread/start', { cwd: env.cwd })
    assert.deepEqual(await turn(tuned.thread.id, { effort: 'low' }), [bare(first.id), 'low'])
    assert.deepEqual(await resumed(tuned.thread.id), [first.id, 'low'])

    // 带着别的引擎的模型名来、又允许回退：用的是默认
    const foreign = await desktop.call('thread/start', {
      cwd: env.cwd,
      model: 'gpt-5.2-codex',
      allowProviderModelFallback: true,
    })
    assert.deepEqual(reported(foreign), [first.id, 'low'], '默认跟着上一次选的变了（强度）')

    // 改了模型：通知和再读都是新的，下一个回合实际用的也是
    const before = desktop.notifications.length
    await desktop.call('thread/settings/update', {
      threadId: plain.thread.id,
      model: other.id,
      effort: 'max',
    })
    const updated = desktop.notifications
      .slice(before)
      .find((entry) => entry.method === 'thread/settings/updated')
    assert.deepEqual(reported(updated.params.threadSettings), [other.id, 'max'])
    assert.deepEqual(await resumed(plain.thread.id), [other.id, 'max'])
    assert.deepEqual(await turn(plain.thread.id), [bare(other.id), 'max'])
    assert.deepEqual(await resumed(plain.thread.id), [other.id, 'max'])
    // 回合带的模型同样算数
    assert.deepEqual(await turn(tuned.thread.id, { model: other.id }), [bare(other.id), 'low'])
    assert.deepEqual(await resumed(tuned.thread.id), [other.id, 'low'])

    // dsh 的默认跟着最近一次选的走：之后没指定模型的新会话报的、用的都是它，和 model/list 一致
    assert.equal((await preferred()).id, other.id)
    const later = await desktop.call('thread/start', { cwd: env.cwd })
    assert.deepEqual(reported(later), [other.id, 'low'])
    assert.deepEqual(await turn(later.thread.id), [bare(other.id), 'low'])
    // 已经说过话的会话不跟着默认变
    assert.deepEqual(await resumed(foreign.thread.id), [other.id, 'low'], '没说过话的跟着默认')
    assert.deepEqual(await resumed(plain.thread.id), [other.id, 'max'])

    // 适配器重启后从 dsh 重新读，报的一样
    await server.close()
    server = new DshServer(home)
    desktop = client(server)
    await desktop.call('initialize', { clientInfo: { name: 'test', version: '0' } })
    assert.deepEqual(await resumed(plain.thread.id), [other.id, 'max'])
    assert.deepEqual(await resumed(tuned.thread.id), [other.id, 'low'])
    assert.deepEqual(await resumed(later.thread.id), [other.id, 'low'])
    assert.deepEqual(await resumed(foreign.thread.id), [other.id, 'low'])
    assert.deepEqual([...violations], [], '往来消息必须符合协议 schema')
  } finally {
    await server.close()
    await env.restore()
  }
})
