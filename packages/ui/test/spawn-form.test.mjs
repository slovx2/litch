// 派子会话弹窗的表单（spawn-form.ts）和沙箱档（sandbox.ts）：初值、手动派的参数、改了再开始的 overrides、
// 目标 harness 收不紧时子会话会是哪一档。
// 跑法：npm run test --prefix packages/ui（Node 直接读 .ts，不用先构建）。
import assert from 'node:assert/strict'
import { test } from 'node:test'

const { fieldsFor, kindOf, overridesOf, spawnParams } = await import('../src/tree/spawn-form.ts')
const { levelOf, widerLevel } = await import('../src/tree/sandbox.ts')

const parent = { harness: 'claude', workspaceId: 'docs' }
const proposal = {
  id: 'pr1',
  title: '整理 CHANGELOG',
  prompt: '把这次的改动整理进 CHANGELOG',
  background: '这一轮加了唤醒开关，还没发版',
  harness: null,
  model: 'opus',
  cwd: '/w/docs',
  kind: 'fork',
  wakeParent: false,
  status: 'pending',
  createdAt: 1,
  expiresAt: 2,
  settledAt: null,
  startedId: null,
  turnId: null,
  callId: null,
  widerSandbox: null,
}

test('初值：手动派的是父会话的默认；提案的照提案预填', () => {
  assert.deepEqual(fieldsFor(parent, null), {
    harness: 'claude',
    model: '',
    effort: '',
    workspaceId: 'docs',
    cwd: '',
    kind: 'fresh',
    title: '',
    prompt: '',
    background: '',
    sandbox: '',
    wake: true,
  })
  const filled = fieldsFor(parent, proposal)
  assert.equal(filled.harness, 'claude')
  assert.equal(filled.model, 'opus')
  assert.equal(filled.cwd, '/w/docs')
  assert.equal(filled.kind, 'fork')
  assert.equal(filled.title, '整理 CHANGELOG')
  assert.equal(filled.background, '这一轮加了唤醒开关，还没发版')
  assert.equal(filled.wake, false)
})

test('带上下文只能同 harness：换了别的就是全新开始', () => {
  const fields = { ...fieldsFor(parent, proposal), harness: 'pi' }
  assert.equal(kindOf(fields, parent), 'fresh')
  assert.equal(kindOf(fieldsFor(parent, proposal), parent), 'fork')
})

test('改了再开始：什么都没改是空的；改了的才带，换 harness 连带改成全新开始、没另选模型时清掉提案的模型', () => {
  assert.deepEqual(overridesOf(fieldsFor(parent, proposal), parent, proposal), {})
  const fields = {
    ...fieldsFor(parent, proposal),
    harness: 'pi',
    model: '',
    effort: 'high',
    workspaceId: 'infra',
    cwd: '  /w/infra ',
    title: '整理更新记录',
    prompt: '  把这次的改动整理进 CHANGELOG  ',
    sandbox: 'read-only',
  }
  assert.deepEqual(overridesOf(fields, parent, proposal), {
    harness: 'pi',
    model: '',
    effort: 'high',
    workspaceId: 'infra',
    cwd: '/w/infra',
    kind: 'fresh',
    title: '整理更新记录',
    sandbox: 'read-only',
  })
})

test('改了再开始：背景只在全新开始时比较，改了带新的，清空了带空串；带上下文的不带', () => {
  const fresh = { ...fieldsFor(parent, proposal), kind: 'fresh' }
  assert.deepEqual(
    overridesOf({ ...fresh, background: ' 这一轮加了唤醒开关，还没发版 ' }, parent, proposal),
    {
      kind: 'fresh',
    },
  )
  assert.deepEqual(overridesOf({ ...fresh, background: '换个说法' }, parent, proposal), {
    kind: 'fresh',
    background: '换个说法',
  })
  assert.deepEqual(overridesOf({ ...fresh, background: '  ' }, parent, proposal), {
    kind: 'fresh',
    background: '',
  })
  // 提案是 fork、还是 fork：背景改了也不带
  assert.deepEqual(
    overridesOf({ ...fieldsFor(parent, proposal), background: '换个说法' }, parent, proposal),
    {},
  )
})

test('改了再开始：“完成后唤醒主会话”照提案预填，改了才带 wakeParent', () => {
  assert.equal(fieldsFor(parent, proposal).wake, proposal.wakeParent)
  assert.deepEqual(
    overridesOf({ ...fieldsFor(parent, proposal), wake: !proposal.wakeParent }, parent, proposal),
    { wakeParent: !proposal.wakeParent },
  )
})

test('手动派：背景全新开始时填了才带，带上下文的不带', () => {
  const fields = {
    ...fieldsFor(parent, null),
    prompt: '查一下链接',
    background: ' 文档站要上线了 ',
  }
  assert.equal(spawnParams(fields, parent).background, '文档站要上线了')
  assert.equal('background' in spawnParams({ ...fields, background: ' ' }, parent), false)
  assert.equal('background' in spawnParams({ ...fields, kind: 'fork' }, parent), false)
})

test('手动派：和父会话一样的不带，填了的才带', () => {
  const fields = { ...fieldsFor(parent, null), prompt: ' 查一下链接 ', wake: false }
  assert.deepEqual(spawnParams(fields, parent), {
    kind: 'fresh',
    title: '',
    prompt: '查一下链接',
    wakeParent: false,
  })
  assert.deepEqual(
    spawnParams(
      { ...fields, harness: 'pi', model: 'm', cwd: '/w', sandbox: 'workspace-write' },
      parent,
    ),
    {
      kind: 'fresh',
      title: '',
      prompt: '查一下链接',
      wakeParent: false,
      harness: 'pi',
      model: 'm',
      cwd: '/w',
      sandbox: 'workspace-write',
    },
  )
})

test('沙箱：目标 harness 给得到的都比要的宽时说出会是哪一档；要的比父会话宽按父会话算', () => {
  assert.equal(levelOf(':workspace'), 'workspace-write')
  assert.equal(levelOf(':custom'), null)
  // Pi 只有完全访问
  assert.equal(widerLevel(':workspace', [':danger-full-access']), 'danger-full-access')
  assert.equal(widerLevel(':workspace', [':workspace', ':danger-full-access']), null)
  // 要只读，目标最严只到项目内
  assert.equal(widerLevel(':workspace', [':workspace'], 'read-only'), 'workspace-write')
  // 要完全访问，会被收紧到父会话那一档，目标给得到
  assert.equal(widerLevel(':read-only', [':read-only', ':workspace'], 'danger-full-access'), null)
  // 认不出父会话的预设：不说
  assert.equal(widerLevel(null, [':danger-full-access']), null)
})
