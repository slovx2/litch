import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import { transformSync } from '../../../node_modules/esbuild/lib/main.js'

const source = readFileSync(new URL('../src/boot/channel.ts', import.meta.url), 'utf8')

for (const dev of [true, false]) {
  test(`状态预览开关${dev ? '仅在开发构建生效' : '从生产构建移除'}`, async () => {
    const { code } = transformSync(source, {
      loader: 'ts',
      format: 'cjs',
      define: { 'import.meta.env.DEV': String(dev) },
      minifySyntax: true,
    })
    if (!dev) assert.ok(!code.includes('mockScene'))
    for (const query of ['?mockScene=states', '']) {
      let options
      const module = { exports: {} }
      runInNewContext(code, {
        module,
        exports: module.exports,
        require: () => ({
          MODEL_RANKING_ENABLED: false,
          createPortPair: () => [{}, {}],
          createMockCore: (value) => {
            options = value
            return {}
          },
          serveChannel: () => {},
          connectChannel: () => ({}),
        }),
        window: {},
        location: { search: query },
        URLSearchParams,
      })
      await module.exports.openChannel('zh-CN')
      assert.equal(options.scene, dev && query ? 'states' : undefined)
    }
  })
}
