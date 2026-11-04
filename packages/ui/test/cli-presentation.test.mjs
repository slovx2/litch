import assert from 'node:assert/strict'
import test from 'node:test'
import { cliPresentation } from '../src/devices/cli-presentation.ts'

const running = {
  path: '/old/real/pi.js',
  version: '1.0.0',
  source: 'path',
  startedAt: 1,
  candidates: [{ path: '/bin/pi', version: '1.0.0', selected: true }],
}

test('安装了更新的一份但旧进程仍在运行：列出新安装，使用标记仍留在旧入口', () => {
  const installed = [
    { path: '/bin/pi', version: '1.0.0', selected: false },
    { path: '/new/pi', version: '2.0.0', selected: true },
  ]
  const view = cliPresentation(running, installed)
  assert.equal(view.selected.version, '1.0.0')
  assert.equal(view.candidates.length, 2)
  assert.deepEqual(
    view.candidates.map((entry) => entry.selected),
    [true, false],
  )
  assert.equal(installed[1].selected, true)
})

test('旧入口文件移走后保留运行快照；停止后显示下次选中的安装', () => {
  const installed = [{ path: '/new/pi', version: '2.0.0', selected: true }]
  const live = cliPresentation(running, installed)
  assert.equal(live.candidates.at(-1).path, running.path)
  assert.equal(live.candidates[0].selected, false)
  const stopped = cliPresentation(undefined, installed)
  assert.equal(stopped.selected.path, '/new/pi')
  assert.equal(cliPresentation(undefined, undefined).selected, undefined)
})
