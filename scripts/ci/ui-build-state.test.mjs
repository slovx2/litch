import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { assertUiBuildFresh, uiBuildStatePlugin } from '../ui-build-state.mjs'

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'litch-ui-build-state-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const put = (name, text = '原始内容') => {
    const path = join(root, name)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, text)
  }
  const inputs = [
    'packages/ui/src/App.tsx',
    'packages/ui/public/prepaint.js',
    'packages/ui/vite.config.ts',
    'packages/core/src/index.mts',
    'packages/protocol/src/device.mts',
    'packages/shared/src/text.mts',
    'packages/ui/package-lock.json',
    'apps/desktop/src/ui-security.mts',
    'extra/theme.json',
  ]
  for (const name of inputs) put(name)
  const begin = () => {
    const plugin = uiBuildStatePlugin(root)
    plugin.configResolved({ root: join(root, 'packages/ui'), build: { outDir: 'dist' } })
    plugin.buildStart()
    plugin.generateBundle.call({ getModuleIds: () => [join(root, 'extra/theme.json')] })
    return () => {
      put('packages/ui/dist/index.html', '构建产物')
      plugin.writeBundle()
    }
  }
  return { root, inputs, put, begin, build: () => begin()() }
}

test('缺产物/缺构建记录拒绝；完整新构建放行，复制制品或 touch 同内容不会误报', (t) => {
  const f = fixture(t)
  assert.throws(() => assertUiBuildFresh(f.root), /npm run client:build/)
  f.put('packages/ui/dist/index.html')
  assert.throws(() => assertUiBuildFresh(f.root), /构建记录/)
  f.build()
  for (const name of f.inputs)
    utimesSync(join(f.root, name), new Date(), new Date(2_000_000_000_000))
  assert.doesNotThrow(() => assertUiBuildFresh(f.root))
})

test('UI、资源、跨包依赖、配置和锁文件改变均拒绝旧产物，即使时间戳倒退', (t) => {
  const f = fixture(t)
  f.build()
  for (const name of f.inputs) {
    f.put(name, '已修改')
    utimesSync(join(f.root, name), new Date(0), new Date(0))
    assert.throws(() => assertUiBuildFresh(f.root), /已过期/)
    f.put(name)
    assert.doesNotThrow(() => assertUiBuildFresh(f.root))
  }
})

test('新增/删除源文件和替换 index 都拒绝；重新构建后恢复', (t) => {
  const f = fixture(t)
  f.build()
  f.put('packages/ui/src/new.ts')
  assert.throws(() => assertUiBuildFresh(f.root), /new.ts/)
  f.build()
  rmSync(join(f.root, 'packages/ui/src/new.ts'))
  assert.throws(() => assertUiBuildFresh(f.root), /new.ts/)
  f.build()
  f.put('packages/ui/dist/index.html', '来自另一份旧构建')
  assert.throws(() => assertUiBuildFresh(f.root), /index.html/)
  f.build()
  assert.doesNotThrow(() => assertUiBuildFresh(f.root))
})

test('构建期间源码变化不能写出有效的新记录', (t) => {
  const f = fixture(t)
  f.build()
  const finish = f.begin()
  f.put(f.inputs[0], '构建中修改')
  assert.throws(finish, /构建期间/)
  assert.throws(() => assertUiBuildFresh(f.root), /已过期/)
})

test('独立预览夹具不覆盖完整 UI 的构建记录', (t) => {
  const f = fixture(t)
  f.build()
  const stamp = join(f.root, 'packages/ui/dist/litch-ui-build.json')
  const before = readFileSync(stamp, 'utf8')
  const plugin = uiBuildStatePlugin(f.root)
  plugin.configResolved({
    root: join(f.root, 'packages/ui'),
    build: { outDir: '/tmp/preview-fixture' },
  })
  plugin.buildStart()
  plugin.generateBundle()
  plugin.writeBundle()
  assert.equal(readFileSync(stamp, 'utf8'), before)
})
