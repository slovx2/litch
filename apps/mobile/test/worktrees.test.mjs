// 手机端的工作树：新建页“起点”的选项和发给设备的起点、按工作区记住位置和起点、提案卡开关进 overrides、
// 详情页“工作树”那一页的几句话，以及接在模拟核心上建一个工作树里的会话。
import assert from 'node:assert/strict'
import { afterEach, beforeEach, test } from 'node:test'
import { createReplica, keys } from '@litch/core'
import { files } from 'expo-file-system'
// 用到的键都在桌面界面那一份里，直接用它的翻译（不经 src/ui/i18n.ts：它要 React 和 expo）
import { translator } from '../../../packages/ui/src/i18n/index.ts'
import { fieldsFor } from '../../../packages/ui/src/tree/spawn-form.ts'
import { overridesFor } from '../src/detail/proposals/logic.ts'
import { baseOf, canSync, syncNote } from '../src/detail/worktree/logic.ts'
import { fromOptions, worktreeParam } from '../src/screens/new-session/worktree.ts'
import { mockChannel, until } from './helpers.mjs'

const t = translator('zh-CN')
let generation = 0
const fresh = (path) => import(`${path}?run=${++generation}`)
const cleanup = []
beforeEach(() => files.clear())
afterEach(() => {
  for (const done of cleanup.splice(0)) done()
})

const branches = {
  current: 'dev',
  defaultBranch: 'main',
  local: ['main', 'dev'],
  remote: ['origin/main'],
}

test('起点的选项：默认分支、当前本地状态在前，本地分支标出当前分支，再是远程分支', () => {
  const options = fromOptions(branches, t)
  assert.deepEqual(
    options.map((option) => option.id),
    ['default', 'working-tree', 'branch:main', 'branch:dev', 'branch:origin/main'],
  )
  assert.equal(options[0].title, '默认分支（main）')
  assert.equal(options.find((option) => option.id === 'branch:dev').note, '当前分支')
  assert.equal(options.find((option) => option.id === 'branch:main').note, undefined)
  // 找不到默认分支写 HEAD
  assert.equal(fromOptions({ ...branches, defaultBranch: null }, t)[0].title, '默认分支（HEAD）')
})

test('发给设备的起点：默认分支不带，当前本地状态、分支照选的', () => {
  assert.deepEqual(worktreeParam('default'), {})
  assert.deepEqual(worktreeParam('working-tree'), { from: { kind: 'working-tree' } })
  assert.deepEqual(worktreeParam('branch:origin/main'), {
    from: { kind: 'branch', branch: 'origin/main' },
  })
})

test('新建页按“设备 + 工作区”记住位置和起点，重开应用还在；不属于工作区的不记', async () => {
  const memory = await fresh('../src/screens/new-session/remembered.ts')
  assert.deepEqual(memory.recallWhere('dev', 'w1'), { worktree: false, from: 'default' })
  memory.rememberWhere('dev', 'w1', { worktree: true, from: 'branch:dev' })
  memory.rememberWhere('dev', null, { worktree: true, from: 'working-tree' })
  const again = await fresh('../src/screens/new-session/remembered.ts')
  assert.deepEqual(again.recallWhere('dev', 'w1'), { worktree: true, from: 'branch:dev' })
  assert.deepEqual(again.recallWhere('dev', 'w2'), { worktree: false, from: 'default' })
  assert.deepEqual(again.recallWhere('dev', null), { worktree: false, from: 'default' })
})

test('“改了再开始”：设备能建工作树时开关进 overrides，不能时不带', () => {
  const parent = { harness: 'claude-code', workspaceId: null, worktree: null }
  const proposal = {
    id: 'p',
    title: '任务',
    prompt: '简报',
    background: '背景',
    harness: null,
    model: null,
    cwd: null,
    kind: 'fresh',
    wakeParent: true,
    worktree: null,
    worktreeDefault: false,
  }
  const fields = fieldsFor(parent, proposal)
  assert.equal(fields.worktree, false)
  assert.deepEqual(overridesFor({ ...fields, worktree: true }, parent, proposal, true), {
    worktree: true,
  })
  assert.deepEqual(overridesFor({ ...fields, worktree: true }, parent, proposal, false), {})
  // 父会话在工作树里：缺省开着
  assert.equal(fieldsFor(parent, { ...proposal, worktreeDefault: true }).worktree, true)
})

const tree = (extra = {}) => ({
  id: 'x',
  path: '/w/x',
  branch: 'litch/x-abc123',
  baseRef: 'main',
  baseCommit: '0'.repeat(40),
  state: 'ready',
  sourceRoot: '/src',
  ...extra,
})

test('“工作树”一页：起点怎么念、什么时候能合入基础分支、合完怎么说', () => {
  assert.equal(baseOf(tree(), t), 'main')
  assert.equal(baseOf(tree({ baseRef: 'working-tree' }), t), '当前本地状态')
  assert.equal(baseOf(tree({ baseRef: 'HEAD' }), t), '当时的 HEAD')
  assert.equal(canSync(tree()), true)
  assert.equal(canSync(tree({ baseRef: 'HEAD' })), false)
  assert.equal(canSync(tree({ baseRef: 'working-tree' })), false)
  assert.equal(canSync(tree({ state: 'removed' })), false)
  assert.equal(syncNote({ status: 'merged', files: [] }, 'main', t), '已合入 main 的新提交。')
  assert.equal(syncNote({ status: 'upToDate', files: [] }, 'main', t), 'main 没有新提交。')
  assert.match(
    syncNote({ status: 'conflicts', files: ['a.ts', 'b.ts'] }, 'main', t),
    /a\.ts、b\.ts/,
  )
})

test('接在模拟核心上：工作区根问得到分支，带着起点建会话，摘要上挂着工作树和分支', async () => {
  const mock = mockChannel()
  const replica = createReplica(mock.channel)
  const stop = replica.start()
  cleanup.push(() => {
    stop()
    mock.close()
  })
  await until(() => replica.store.get(keys.summary('local', 's5')), { what: '侧栏' })
  // 示例里的工作树会话：摘要带着工作树（会话行写分支、详情菜单有“工作树”就靠它）
  assert.equal(
    replica.store.get(keys.summary('local', 's5')).worktree.branch,
    'litch/sidebar-tweaks-3f2a1c',
  )
  const { branches: found } = await mock.channel.command('worktree.branches', {
    deviceId: 'local',
    cwd: '~/work/litch',
  })
  assert.equal(found.defaultBranch, 'main')
  const { branches: none } = await mock.channel.command('worktree.branches', {
    deviceId: 'local',
    cwd: '/somewhere/else',
  })
  assert.equal(none, null)
  const { sessionId } = await mock.channel.command('session.create', {
    deviceId: 'local',
    cwd: '~/work/litch',
    text: '在工作树里改',
    worktree: worktreeParam('branch:release/0.18'),
  })
  const made = await until(() => replica.store.get(keys.summary('local', sessionId))?.worktree, {
    what: '新会话的工作树',
  })
  assert.equal(made.baseRef, 'release/0.18')
  assert.equal(made.state, 'ready')
})
