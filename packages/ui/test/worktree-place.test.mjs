// 新建页“在哪做”“从哪切”的判断：选项标识换成起点、记下的分支没了退回默认分支、按设备加工作区记住上次选的。
// 不起浏览器：worktree-place.ts 只有判断。跑法：npm run test --prefix packages/ui。
import assert from 'node:assert/strict'
import { test } from 'node:test'

const memory = new Map()
globalThis.localStorage = {
  getItem: (key) => memory.get(key) ?? null,
  setItem: (key, value) => memory.set(key, String(value)),
}

const { branchFrom, FROM_DEFAULT, FROM_WORKING, fitFrom, fromOf, recallWhere, rememberWhere } =
  await import('../src/composer/worktree-place.ts')

const branches = {
  current: 'main',
  defaultBranch: 'main',
  local: ['main', 'dev'],
  remote: ['origin/main'],
}

test('起点：默认分支不带，当前本地状态、分支照说', () => {
  assert.equal(fromOf(FROM_DEFAULT), undefined)
  assert.deepEqual(fromOf(FROM_WORKING), { kind: 'working-tree' })
  assert.deepEqual(fromOf(branchFrom('origin/main')), { kind: 'branch', branch: 'origin/main' })
})

test('记下的分支现在没有了（或者分支还没问到）退回默认分支；别的照旧', () => {
  assert.equal(fitFrom(branchFrom('dev'), branches), branchFrom('dev'))
  assert.equal(fitFrom(branchFrom('gone'), branches), FROM_DEFAULT)
  assert.equal(fitFrom(branchFrom('dev'), undefined), FROM_DEFAULT)
  assert.equal(fitFrom(FROM_WORKING, null), FROM_WORKING)
  assert.equal(fitFrom('junk', branches), FROM_DEFAULT)
})

test('按设备加工作区记；没记过、没有工作区是本地', () => {
  assert.deepEqual(recallWhere('local', 'litch'), { worktree: false, from: FROM_DEFAULT })
  rememberWhere('local', 'litch', { worktree: true, from: FROM_WORKING })
  rememberWhere('local', null, { worktree: true, from: FROM_WORKING })
  assert.deepEqual(recallWhere('local', 'litch'), { worktree: true, from: FROM_WORKING })
  assert.deepEqual(recallWhere('local', 'docs'), { worktree: false, from: FROM_DEFAULT })
  assert.deepEqual(recallWhere('local', null), { worktree: false, from: FROM_DEFAULT })
})
