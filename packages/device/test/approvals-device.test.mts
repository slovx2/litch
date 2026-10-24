// 聚合面上的手机批准：runtime/info 列 clientApprovals；litch/approval/* 不转给引擎；changed 只发给声明了的连接，
// answered 只发给发卡片的那条；发卡片的连接断开时卡片收掉。参数、应答、通知按 protocol/extensions/client-approvals.json 校验。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { Ajv } from 'ajv'
import { answer, card } from './approvals-kit.mjs'
import { REPO, rig } from './helpers.mjs'

const definition = JSON.parse(
  readFileSync(join(REPO, 'protocol/extensions/client-approvals.json'), 'utf8'),
)
const ajv = new Ajv({ strict: false, allErrors: true })

function part(kind: string, method?: string): any {
  const found = definition.parts.find(
    (item: any) => item.kind === kind && (method === undefined || item.method === method),
  )
  if (!found) throw new Error(`扩展定义里没有 ${kind} ${method ?? ''}`)
  return found
}

function check(schema: unknown, value: unknown, what: string): void {
  const validate = ajv.compile({ ...(schema as object), definitions: definition.definitions })
  if (!validate(value))
    throw new Error(`${what} 和扩展定义对不上：${JSON.stringify(validate.errors)}`)
}

const params = (method: string, value: unknown) =>
  check(part('ClientRequest', method).params, value, `${method} 的参数`)
const response = (method: string, value: unknown) =>
  check(part('ClientRequest', method).response, value, `${method} 的应答`)
const notice = (method: string, value: unknown) =>
  check(part('ServerNotification', method).params, value, `${method} 的通知`)

test('聚合面：挂卡片、手机取和答、桌面端收到答复、断开收掉；没声明的连接什么都收不到', async () => {
  const device = rig({})
  try {
    const desktop = device.connect()
    await desktop.initialize(['harness', 'clientApprovals'])
    const phone = device.connect()
    await phone.initialize(['harness', 'clientApprovals'])
    const plain = device.connect()
    await plain.initialize(['harness'])
    assert.ok((await plain.call('runtime/info')).device.extensions.includes('clientApprovals'))
    // 没声明的连接挂不了
    const undeclared = await plain.fails('litch/approval/open', card())
    assert.deepEqual([undeclared.code, undeclared.data], [-32000, { reason: 'undeclared' }])
    check(part('Error').data, undeclared.data, 'error.data')

    params('litch/approval/open', card())
    response('litch/approval/open', await desktop.call('litch/approval/open', card()))
    const opened = await phone.waitFor((frame) => frame.method === 'litch/approval/changed')
    notice('litch/approval/changed', opened.params)
    // list 带 threadId 也不转给引擎（聚合面上没有这个会话）
    const listed = await phone.call('litch/approval/list', { threadId: 'thread-1' })
    response('litch/approval/list', listed)
    assert.equal(listed.data.length, 1)

    params('litch/approval/answer', answer())
    response('litch/approval/answer', await phone.call('litch/approval/answer', answer()))
    const answered = await desktop.waitFor((frame) => frame.method === 'litch/approval/answered')
    notice('litch/approval/answered', answered.params)
    assert.deepEqual(answered.params, answer())

    // 发卡片的那条断了：收掉
    desktop.close()
    const closed = await phone.waitFor(
      (frame) =>
        frame.method === 'litch/approval/changed' && (frame.params as any).data.length === 0,
    )
    notice('litch/approval/changed', closed.params)
    const gone = await phone.fails('litch/approval/answer', answer())
    assert.deepEqual([gone.code, gone.data], [-32602, { reason: 'unknownApproval' }])
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.ok(!plain.notifications.some((frame) => frame.method?.startsWith('litch/approval/')))
    assert.ok(!phone.notifications.some((frame) => frame.method === 'litch/approval/answered'))
  } finally {
    await device.close()
  }
})
