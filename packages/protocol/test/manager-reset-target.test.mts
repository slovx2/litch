import assert from 'node:assert/strict'
import test from 'node:test'
import { Ajv2019 } from 'ajv/dist/2019.js'
import managerSchema from '../../../protocol/extensions/manager.json' with { type: 'json' }
import targetSchema from '../../../protocol/extensions/manager-reset-target.json' with {
  type: 'json',
}
import { EXTENSION } from '../src/device.mjs'
import {
  MANAGER_DEFAULT_CONTACT,
  MANAGER_DEFAULT_DISPATCH,
  MANAGER_METHOD,
  MANAGER_RESET_TARGET_EXTENSION,
  type Manager,
} from '../src/manager.mjs'

const ajv = new Ajv2019({ strict: false, allErrors: true })
ajv.addSchema(managerSchema, 'manager.json')
ajv.addSchema(targetSchema, 'manager-reset-target.json')
const validate = (definition: string, value: unknown) => {
  const check = ajv.compile({ $ref: `manager-reset-target.json#/definitions/${definition}` })
  assert.equal(check(value), true, JSON.stringify(check.errors))
}

test('目标扩展登记与设备类型一致；保护字段缺一个都不能提交', () => {
  assert.equal(targetSchema.extension, EXTENSION.managerResetTarget)
  assert.equal(MANAGER_RESET_TARGET_EXTENSION, EXTENSION.managerResetTarget)
  assert.ok(
    targetSchema.parts.some(
      (part) => part.kind === 'ClientRequest' && part.method === MANAGER_METHOD.resetPreview,
    ),
  )
  const params = {
    managerId: 'manager',
    target: { harness: 'codex', model: 'model', effort: 'high', permission: ':workspace' },
    expectedThreadId: 'source',
    expectedSettingsHash: 'hash',
    requestId: 'request',
  }
  validate('ResetParams', params)
  const check = ajv.compile({ $ref: 'manager-reset-target.json#/definitions/ResetParams' })
  for (const field of ['target', 'expectedThreadId', 'expectedSettingsHash', 'requestId']) {
    const missing: Record<string, unknown> = { ...params }
    delete missing[field]
    assert.equal(check(missing), false)
  }
})

test('新合同接受耐久接班状态，旧合同只接受过滤后的普通经理状态', () => {
  const manager: Manager = {
    id: 'manager',
    threadId: 'candidate',
    name: '经理',
    scope: '',
    cwd: '/work',
    harness: 'codex',
    model: 'target',
    effort: 'high',
    permission: ':workspace',
    template: 'blank',
    dispatch: { ...MANAGER_DEFAULT_DISPATCH },
    contact: { ...MANAGER_DEFAULT_CONTACT },
    rules: '',
    status: 'active',
    pendingDecisions: 0,
    runningLines: 0,
    latestActivity: null,
    createdAt: 1,
    updatedAt: 2,
    endedAt: null,
    reset: {
      mode: 'replace',
      current: 'fingerprint',
      applied: 'fingerprint',
      outdated: false,
      phase: 'ready',
      operation: {
        requestId: 'request',
        source: {
          threadId: 'source',
          harness: 'claude-code',
          model: 'source',
          effort: 'medium',
          permission: ':workspace',
        },
        target: { harness: 'codex', model: 'target', effort: 'high', permission: ':workspace' },
        expectedSettingsHash: 'hash',
        candidateThreadId: 'candidate',
        committed: true,
        handover: 'failed',
      },
    },
  }
  validate('ManagerResponse', { manager })
  const old = ajv.compile({ $ref: 'manager.json#/definitions/ManagerResponse' })
  assert.equal(old({ manager }), false)
  const { operation: _operation, ...reset } = manager.reset!
  assert.equal(old({ manager: { ...manager, reset } }), true)
})
