import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  fileBrowserKey,
  fileBrowserRoot,
  parentPath,
  sessionFileScope,
  setFileBrowserRoot,
} from '../src/index.mjs'

test('本次运行的浏览根按设备和会话隔离；无会话按项目隔离', () => {
  const a = fileBrowserKey('remote', 'one', 'project')
  const b = fileBrowserKey('remote', 'two', 'project')
  const c = fileBrowserKey('local', 'one', 'project')
  assert.equal(fileBrowserRoot(a, '/work/app'), '/work/app')
  setFileBrowserRoot(a, '/work')
  assert.equal(fileBrowserRoot(a, '/work/app'), '/work')
  assert.equal(fileBrowserRoot(b, '/work/app'), '/work/app')
  assert.equal(fileBrowserRoot(c, '/work/app'), '/work/app')
  assert.notEqual(fileBrowserKey('remote', null, 'p1'), fileBrowserKey('remote', null, 'p2'))
  setFileBrowserRoot(a, '/work/app')
  assert.equal(fileBrowserRoot(a, '/work/app'), '/work/app')
})

test('默认根保持单根、多根、无项目与工作树规则；设备根不能继续向上', () => {
  assert.equal(sessionFileScope({ cwd: '/work/app/src' }, ['/work/app'])?.root, '/work/app')
  assert.equal(sessionFileScope({ cwd: '/two/src' }, ['/one', '/two'])?.root, '/two')
  assert.equal(sessionFileScope({ cwd: '/no-project' })?.root, '/no-project')
  assert.equal(
    sessionFileScope({ cwd: '/tree/src', worktree: { state: 'ready', path: '/tree' } }, [
      '/project',
    ])?.root,
    '/tree',
  )
  assert.equal(parentPath('/'), null)
  assert.equal(parentPath('C:/'), null)
  assert.equal(parentPath('D:/work'), 'D:/')
})
