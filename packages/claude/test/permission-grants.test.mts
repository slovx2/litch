import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  activePermissionRoots,
  copyPermissionOverlay,
  mergePermissionOverlay,
  parsePermissionGrant,
  parsePermissionProposal,
} from '../src/permission-grants.mjs'
import { deniedTool, sandboxedBashInput } from '../src/runtime-permissions.mjs'
import type { RuntimeTurnContext } from '../src/types.mjs'

test('权限提案只接受现有绝对路径，部分授权不能扩大提案或忽略 strictAutoReview', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'permission-validation-')))
  try {
    const a = join(root, 'a'),
      b = join(root, 'b')
    mkdirSync(a)
    mkdirSync(b)
    const proposal = parsePermissionProposal({ permissions: { fileSystem: { write: [a] } } })
    const partial = parsePermissionGrant(proposal, {
      permissions: { fileSystem: { read: [a] } },
      scope: 'turn',
    })
    assert.deepEqual(partial.permissions.fileSystem, { read: [a], write: null })
    for (const answer of [
      { permissions: { fileSystem: { write: [b] } }, scope: 'turn' },
      { permissions: { network: { enabled: true } }, scope: 'turn' },
      { permissions: proposal.permissions, scope: 'session', strictAutoReview: true },
      { permissions: proposal.permissions, scope: 'other' },
      { permissions: { fileSystem: { entries: [] } }, scope: 'turn' },
    ])
      assert.throws(() => parsePermissionGrant(proposal, answer))
    for (const path of ['relative', join(root, 'missing')])
      assert.throws(() =>
        parsePermissionProposal({ permissions: { fileSystem: { write: [path] } } }),
      )
    assert.deepEqual(
      parsePermissionGrant(proposal, { permissions: {}, scope: 'turn' }).permissions,
      {},
    )
    assert.deepEqual(parsePermissionGrant(proposal, { permissions: {}, strictAutoReview: null }), {
      permissions: {},
      scope: 'turn',
    })
    assert.deepEqual(
      parsePermissionGrant(proposal, { permissions: { network: {} } }).permissions.network,
      { enabled: null },
    )
    assert.throws(() => parsePermissionGrant(proposal, { permissions: {}, scope: null }))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('只读 overlay 不开放 cwd/tmp，计划及符号链接仍拒绝，原始配置保持不变', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'permission-overlay-')))
  try {
    const a = join(root, 'a'),
      b = join(root, 'b'),
      cwd = join(root, 'project')
    for (const dir of [a, b, cwd]) mkdirSync(dir)
    symlinkSync(b, join(a, 'escape'))
    const context = {
      cwd,
      threadId: 'test',
      sandboxMode: 'read-only',
      sandboxPolicy: { type: 'readOnly', networkAccess: false },
      planMode: false,
    } as RuntimeTurnContext
    const baseline = structuredClone(context.sandboxPolicy)
    context.permissionGrants = mergePermissionOverlay(undefined, {
      permissions: { fileSystem: { read: null, write: [a] } },
      scope: 'turn',
    })
    const copy = copyPermissionOverlay(context.permissionGrants)
    copy.writeRoots.push(b)
    assert.deepEqual(context.permissionGrants.writeRoots, [a])
    assert.equal(deniedTool(context, 'Write', { file_path: join(a, 'ok') }), null)
    for (const file of [
      join(cwd, 'no'),
      join(b, 'no'),
      join(a, 'escape/no'),
      '/tmp/not-authorized',
    ])
      assert.ok(deniedTool(context, 'Write', { file_path: file }))
    const input = sandboxedBashInput(context, { command: 'true', dangerouslyDisableSandbox: true })
    assert.equal(input.dangerouslyDisableSandbox, false)
    assert.ok(String(input.command).includes(a))
    assert.deepEqual(context.sandboxPolicy, baseline)
    context.planMode = true
    assert.ok(deniedTool(context, 'Write', { file_path: join(a, 'no-plan') }))
    rmSync(a, { recursive: true })
    symlinkSync(b, a)
    assert.deepEqual(activePermissionRoots(context.permissionGrants), [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
