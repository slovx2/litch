// 严格校验器自己的测试：协议兼容性测试（upstream-compat.test.mts）全靠它报出入，
// 它要是把坏消息放过去，那几条用例就白跑了。校验器在 packages/shared/test/，这里只是借 Pi 这一包的测试来跑。
import assert from 'node:assert/strict'
import test from 'node:test'
import { baselineOf } from '../../shared/test/compat-baseline.mjs'
import { findingKey } from '../../shared/test/strict-schema.mjs'
import { inspect } from '../../shared/test/strict-wire.mjs'

const nothing = () => undefined
const keys = (message: unknown, requested: (id: unknown) => string | undefined = nothing) =>
  inspect(message, requested).map(findingKey)
const item = (fields: Record<string, unknown>) => ({
  method: 'item/completed',
  params: { threadId: 't', turnId: 'u', completedAtMs: 1, item: fields },
})

test('合乎上游结构的消息没有出入', () => {
  assert.deepEqual(keys({ method: 'thread/archived', params: { threadId: 't' } }), [])
  assert.deepEqual(
    keys({ id: 1, result: {} }, () => 'thread/archive'),
    [],
  )
  assert.deepEqual(keys({ id: 1, error: { code: -32601, message: 'x', data: { any: 1 } } }), [])
  assert.deepEqual(
    keys(item({ type: 'agentMessage', id: 'i', text: '好', phase: null, memoryCitation: null })),
    [],
  )
})

test('多出的字段、缺的字段、类型不对，都报得出来，位置写到所在的对象', () => {
  assert.deepEqual(keys({ method: 'thread/archived', params: { threadId: 't', pinned: true } }), [
    'notification thread/archived / 多出字段 pinned',
  ])
  assert.deepEqual(keys({ method: 'thread/archived', params: {} }), [
    'notification thread/archived / 缺少字段 threadId',
  ])
  assert.deepEqual(keys({ method: 'thread/archived', params: { threadId: 5 } }), [
    'notification thread/archived /threadId 类型不符，应为 string',
  ])
  // 带 type 的联合类型：位置后面附上变体的名字，多出的字段算在那个变体头上
  assert.deepEqual(
    keys(
      item({
        type: 'agentMessage',
        id: 'i',
        text: '好',
        phase: null,
        memoryCitation: null,
        ours: 1,
      }),
    ),
    ['notification item/completed /item<agentMessage> 多出字段 ours'],
  )
  assert.deepEqual(keys(item({ type: 'hologram', id: 'i' })), [
    'notification item/completed /item<hologram> 未知的 type 取值：hologram',
  ])
})

test('上游没有的通知和服务端请求算出入，不是放过去', () => {
  assert.deepEqual(keys({ method: 'litch/somethingNew', params: {} }), [
    'notification litch/somethingNew / 上游没有这个通知',
  ])
  assert.deepEqual(keys({ id: 1, method: 'litch/ask', params: {} }), [
    'serverRequest litch/ask / 上游没有这个服务端请求',
  ])
})

test('服务端请求的参数、应答、信封各按各的结构校验', () => {
  assert.deepEqual(
    keys({
      id: 1,
      method: 'item/commandExecution/requestApproval',
      params: { threadId: 't', turnId: 'u', itemId: 'i', startedAtMs: 1, decisions: ['accept'] },
    }),
    ['serverRequest item/commandExecution/requestApproval / 多出字段 decisions'],
  )
  // 信封：上游线上的消息不带 jsonrpc
  assert.deepEqual(
    keys({ jsonrpc: '2.0', id: 1, result: {} }, () => 'thread/archive'),
    ['envelope response / 多出字段 jsonrpc'],
  )
  assert.deepEqual(keys({ id: 1, error: { code: -32601, message: 'x', hint: 1 } }), [
    'envelope error /error 多出字段 hint',
  ])
  assert.deepEqual(keys({ id: 9, result: {} }), ['envelope response /id 应答对不上任何请求'])
  // 上游已经不导出结构、仓库里补了定义的旧方法也校验得到
  assert.deepEqual(
    keys({ id: 1, result: { sha: 'a', diff: '' } }, () => 'gitDiffToRemote'),
    [],
  )
  assert.deepEqual(
    keys({ id: 1, result: { sha: 'a' } }, () => 'gitDiffToRemote'),
    ['response gitDiffToRemote / 缺少字段 diff'],
  )
  // 找不到结构定义的应答不是悄悄放过
  assert.deepEqual(
    keys({ id: 1, result: {} }, () => 'litch/whatever'),
    ['response litch/whatever / 没有可用来校验这个应答的结构定义'],
  )
})

test('公共字段加带判别字段的分支（MCP 征询的请求）：分支认的字段不算多出来的', () => {
  const ask = (fields: Record<string, unknown>) =>
    keys({
      id: 1,
      method: 'mcpServer/elicitation/request',
      params: { threadId: 't', turnId: null, serverName: 's', ...fields },
    })
  const form = {
    mode: 'form',
    message: '填一下',
    requestedSchema: { type: 'object', properties: { name: { type: 'string' } } },
  }
  assert.deepEqual(ask(form), [])
  assert.deepEqual(
    ask({ mode: 'url', message: '去网页上办', url: 'http://x', elicitationId: 'e', _meta: {} }),
    [],
  )
  // 多出来的、缺的，仍然只报真有出入的那一个
  assert.deepEqual(ask({ ...form, ours: 1 }), [
    'serverRequest mcpServer/elicitation/request / 多出字段 ours',
  ])
  assert.deepEqual(ask({ mode: 'form', message: '填一下' }), [
    'serverRequest mcpServer/elicitation/request / 缺少字段 requestedSchema',
  ])
  // 表里的栏目也封闭着：上游的栏目没有 pattern
  const patterned = ask({
    ...form,
    requestedSchema: { type: 'object', properties: { name: { type: 'string', pattern: 'x' } } },
  })
  assert.ok(
    patterned.some((key) => key.endsWith('多出字段 pattern')),
    patterned.join('\n'),
  )
})

test('结构定义的勘误生效：时间线里回合边界的字段按驼峰校验', () => {
  const timeline = (entry: Record<string, unknown>) =>
    keys({ id: 1, result: { data: [entry], nextCursor: null } }, () => 'thread/timeline/list')
  const camel = timeline({ type: 'turnStarted', turnId: 'u', startedAt: 1, position: 0 })
  assert.ok(!camel.some((key) => /turnId|startedAt|turn_id|started_at/.test(key)), camel.join('\n'))
  const snake = timeline({ type: 'turnStarted', turn_id: 'u', started_at: 1, position: 0 })
  assert.ok(
    snake.includes('response thread/timeline/list /data/*<turnStarted> 多出字段 turn_id'),
    snake.join('\n'),
  )
  assert.ok(
    snake.includes('response thread/timeline/list /data/*<turnStarted> 缺少字段 turnId'),
    snake.join('\n'),
  )
})

test('基线清单读得进来，每一组都写了原因', () => {
  for (const entry of ['claude', 'pi', 'dsh', 'device'])
    for (const [key, reason] of baselineOf(entry)) assert.ok(reason.trim(), key)
})
