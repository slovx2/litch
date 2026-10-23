// 会话的文件根（side/roots.ts）：侧面板和对话里的文件链接共用，工作树会话两边都得是那棵工作树。
// 跑法：npm run test --prefix packages/ui。
import assert from 'node:assert/strict'
import { test } from 'node:test'

const { sessionRoots } = await import('../src/side/roots.ts')

const tree = (state) => ({
  id: 'wt',
  path: '/wt/litch/wt',
  branch: 'litch/wt',
  baseRef: 'main',
  baseCommit: 'abc',
  state,
  sourceRoot: '/work/litch',
})

test('工作树会话的根是工作树，不看工作区；目录删了的退回工作区', () => {
  const cwd = '/wt/litch/wt/packages/ui'
  assert.deepEqual(sessionRoots({ cwd, worktree: tree('ready') }, ['/work/litch']), [
    '/wt/litch/wt',
  ])
  assert.deepEqual(sessionRoots({ cwd, worktree: tree('kept') }, undefined), ['/wt/litch/wt'])
  assert.deepEqual(sessionRoots({ cwd, worktree: tree('removed') }, ['/work/litch']), [
    '/work/litch',
  ])
})

test('不在工作树里：工作区的根，没有工作区的是工作目录，什么都没有是空的', () => {
  assert.deepEqual(sessionRoots({ cwd: '/work/litch/src' }, ['/work/litch', '/work/docs']), [
    '/work/litch',
    '/work/docs',
  ])
  assert.deepEqual(sessionRoots({ cwd: '/tmp/x' }, undefined), ['/tmp/x'])
  assert.deepEqual(sessionRoots({ cwd: '' }, undefined), [])
  assert.deepEqual(sessionRoots(undefined, undefined), [])
})
