import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  applyOrganizer,
  emptyOrganizer,
  localLayout,
  type MemberRef,
  parseOrganizer,
  refKey,
  type WorkspaceView,
} from '../src/index.mjs'

const session = (id: string): MemberRef => ({ kind: 'session', deviceId: 'mac', sessionId: id })
const workspace = (id: string): MemberRef => ({
  kind: 'workspace',
  deviceId: 'mac',
  workspaceId: id,
})

test('项目成员增、删、跨组移动、组内排序；实体类型参与去重', () => {
  let file = emptyOrganizer()
  let n = 0
  const apply = (action: Parameters<typeof applyOrganizer>[1]) => {
    file = applyOrganizer(file, action, () => `g${++n}`)
  }
  apply({
    type: 'group.create',
    name: '一',
    members: [workspace('w'), workspace('w'), session('w')],
  })
  apply({ type: 'group.create', name: '二' })
  assert.deepEqual(file.groups[0]?.members, [workspace('w'), session('w')])
  apply({ type: 'member.add', groupId: 'g2', member: workspace('w') })
  assert.deepEqual(file.groups[0]?.members, [session('w')])
  apply({ type: 'member.add', groupId: 'g2', member: workspace('x') })
  apply({ type: 'member.move', member: workspace('w'), to: 1 })
  assert.deepEqual(file.groups[1]?.members, [workspace('x'), workspace('w')])
  const revision = file.revision
  apply({ type: 'member.add', groupId: 'g2', member: workspace('w') })
  assert.equal(file.revision, revision)
  apply({ type: 'member.remove', member: workspace('x') })
  assert.deepEqual(file.groups[1]?.members, [workspace('w')])
  assert.equal(parseOrganizer(file).kind, 'ok')
  assert.equal(
    parseOrganizer({
      ...file,
      groups: [...file.groups, { id: 'g3', name: '三', members: [workspace('w')] }],
    }).kind,
    'corrupt',
  )
})

test('v1 只接受原始纯会话子集；迁移保留组、顺序、折叠、置顶与修订号', () => {
  const old = {
    version: 1,
    revision: 17,
    groups: [{ id: 'g', name: '旧组', members: [{ deviceId: 'mac', sessionId: 's' }] }],
    pinOrder: [workspace('w')],
    folds: { g: true },
  }
  const parsed = parseOrganizer(old)
  assert.deepEqual(parsed, {
    kind: 'ok',
    file: { ...old, version: 2, groups: [{ ...old.groups[0], members: [session('s')] }] },
  })
  for (const member of [workspace('w'), session('s'), { deviceId: 'mac', workspaceId: 'w' }])
    assert.equal(
      parseOrganizer({ ...old, groups: [{ ...old.groups[0], members: [member] }] }).kind,
      'corrupt',
    )
  assert.equal(parseOrganizer({ ...old, version: 2 }).kind, 'corrupt', 'v2 不接受无类型引用')
  assert.deepEqual(parseOrganizer({ version: 3 }), { kind: 'newer', version: 3 })
})

test('显式会话优先于项目；跨组、后代、置顶按实体去重，取消置顶保留成员位置', () => {
  const groups = [
    { id: 'a', name: '一', members: [workspace('w'), session('parent')] },
    { id: 'b', name: '二', members: [session('child'), workspace('pinned')] },
  ]
  const source = {
    deviceId: 'mac',
    groups: { w: ['parent', 'child', 'other', 'pin'], pinned: ['pin'] },
    children: { parent: ['child', 'grandchild'], child: ['leaf'] },
    workspaces: [
      { id: 'w', pinned: false },
      { id: 'pinned', pinned: true },
    ] as WorkspaceView[],
    covered: ['pin'],
  }
  const layout = localLayout(groups, [source])
  assert.deepEqual(layout.groups.get('b'), { visible: [session('child')], pinned: 1 })
  assert.deepEqual(layout.trees.get(refKey(workspace('w')))?.roots, ['other'])
  assert.ok(layout.trees.get(refKey(session('parent')))?.excluded.has('child'))
  assert.ok(layout.trees.get(refKey(workspace('w')))?.excluded.has('grandchild'))
  assert.ok(!layout.trees.get(refKey(session('child')))?.excluded.has('leaf'))
  const unpinned = localLayout(groups, [
    {
      ...source,
      workspaces: source.workspaces.map((entry) => ({ ...entry, pinned: false })),
      covered: [],
    },
  ])
  assert.deepEqual(unpinned.groups.get('b'), { visible: groups[1]?.members, pinned: 0 })
  assert.deepEqual(unpinned.trees.get(refKey(workspace('w')))?.roots, ['other', 'pin'])
  assert.deepEqual(groups[1]?.members, [session('child'), workspace('pinned')], '投影不改引用顺序')
})
