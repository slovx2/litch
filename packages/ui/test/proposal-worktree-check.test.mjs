import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from '../../../node_modules/esbuild/lib/main.js'

// 最小 hooks 宿主驱动真实共享 hook，验证两端共用的异步门禁、取消和旧应答竞态。
const built = await build({
  entryPoints: [new URL('../src/tree/useProposalWorktree.ts', import.meta.url).pathname],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  write: false,
  external: ['react'],
})
function rig() {
  let cursor = 0
  const cells = []
  const effects = []
  const equal = (a, b) => a && b.every((value, i) => Object.is(value, a[i]))
  const hooks = {
    useState(initial) {
      const i = cursor++
      cells[i] ??= { value: initial }
      return [
        cells[i].value,
        (value) => {
          cells[i].value = value
        },
      ]
    },
    useMemo(make, deps) {
      const i = cursor++
      if (!equal(cells[i]?.deps, deps)) cells[i] = { value: make(), deps }
      return cells[i].value
    },
    useEffect(run, deps) {
      const i = cursor++
      if (!equal(cells[i]?.deps, deps)) {
        const previous = cells[i]
        cells[i] = { deps }
        effects.push(() => {
          previous?.cleanup?.()
          cells[i].cleanup = run()
        })
      }
    },
  }
  const module = { exports: {} }
  new Function('require', 'module', 'exports', built.outputFiles[0].text)(
    () => hooks,
    module,
    module.exports,
  )
  const calls = []
  const channel = {
    command: (name, params) =>
      new Promise((resolve, reject) => calls.push({ name, params, resolve, reject })),
  }
  return {
    calls,
    render(enabled, cwd) {
      cursor = 0
      // biome-ignore lint/correctness/useHookAtTopLevel: 此处是测试用 hooks 渲染宿主。
      const result = module.exports.useProposalWorktree(
        channel,
        'device',
        'source',
        'card',
        enabled,
        cwd,
      )
      for (const run of effects.splice(0)) run()
      return result
    },
  }
}

test('关闭时不查；勾选后先拦开始，非 Git 解释原因；取消勾选立即可共享目录开始', async () => {
  const r = rig()
  assert.equal(r.render(false), null)
  assert.equal(r.calls.length, 0)
  assert.equal(r.render(true), 'worktree.check.pending')
  assert.equal(r.calls[0].name, 'session.proposal.checkWorktree')
  assert.deepEqual(r.calls[0].params, {
    deviceId: 'device',
    sessionId: 'source',
    proposalId: 'card',
  })
  r.calls[0].resolve({ available: false })
  await Promise.resolve()
  assert.equal(r.render(true), 'worktree.check.notRepo')
  assert.equal(r.render(false), null)
})

test('可创建时放行；改目录和重新勾选都重新检查，迟到应答不能放行新目录', async () => {
  const r = rig()
  r.render(true, '/repo')
  r.calls[0].resolve({ available: true })
  await Promise.resolve()
  assert.equal(r.render(true, '/repo'), null)
  assert.equal(r.render(true, '/other'), 'worktree.check.pending')
  assert.equal(r.render(true, '/third'), 'worktree.check.pending')
  r.calls[1].resolve({ available: true })
  await Promise.resolve()
  assert.equal(r.render(true, '/third'), 'worktree.check.pending')
  r.calls[2].resolve({ available: false })
  await Promise.resolve()
  assert.equal(r.render(true, '/third'), 'worktree.check.notRepo')
  r.render(false, '/repo')
  assert.equal(r.render(true, '/repo'), 'worktree.check.pending')
  r.calls[3].reject(new Error('offline'))
  await Promise.resolve()
  assert.equal(r.render(true, '/repo'), 'worktree.check.failed')
})
