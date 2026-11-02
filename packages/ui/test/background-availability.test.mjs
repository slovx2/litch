// 执行两端正式后台页，替换外部订阅；空任务时也必须显示原因，关闭和已安装时不显示。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { build } from '../../../node_modules/esbuild/lib/main.js'

async function component(path, name) {
  const imports = new Map(
    [...readFileSync(path, 'utf8').matchAll(/import\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/g)].map(
      (match) => [
        match[2],
        match[1]
          .split(',')
          .map((part) => part.trim())
          .filter((part) => part && !part.startsWith('type ')),
      ],
    ),
  )
  const values = {
    memo: 'f=>f',
    useEffect: '()=>{}',
    useMemo: 'f=>f()',
    useState: 'x=>[x,()=>{}]',
    useKey: '()=>undefined',
    useReported: '()=>new Map()',
    usePickedBackground: '()=>null',
    useBackgroundEntries: '()=>globalThis.__nativeBackgroundView',
    useT: '()=>((key)=>key)',
    useTheme: '()=>({c:{}})',
    StyleSheet: '{create:x=>x}',
    keys: '{device:()=>"d",summary:()=>"s"}',
    Text: '"Text"',
    View: '"View"',
    ScrollView: '"ScrollView"',
  }
  const result = await build({
    entryPoints: [path],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'node',
    tsconfigRaw: {
      compilerOptions: { jsx: 'react', jsxFactory: 'h', jsxFragmentFactory: 'Fragment' },
    },
    jsx: 'transform',
    jsxFactory: 'h',
    jsxFragment: 'Fragment',
    banner: {
      js: 'const h=(type,props,...children)=>({type,props:{...props,children}}),Fragment="fragment";',
    },
    plugins: [
      {
        name: 'background-fixture',
        setup(api) {
          api.onResolve({ filter: /.*/ }, (args) =>
            imports.has(args.path) && args.importer === path
              ? { path: args.path, namespace: 'fixture' }
              : undefined,
          )
          api.onLoad({ filter: /.*/, namespace: 'fixture' }, (args) => ({
            resolveDir: new URL('../../../', import.meta.url).pathname,
            contents: imports
              .get(args.path)
              .map((key) =>
                key === 'nativeBackgroundHint'
                  ? 'export {nativeBackgroundHint} from "./packages/core/src/projection/background.mts";'
                  : `export const ${key}=${values[key] ?? '()=>null'};`,
              )
              .join('\n'),
          }))
        },
      },
    ],
  })
  return (
    await import(
      `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`
    )
  )[name]
}

const nodes = (node) =>
  !node || typeof node !== 'object'
    ? []
    : Array.isArray(node)
      ? node.flatMap(nodes)
      : [node, ...nodes(node.props?.children)]

for (const [path, name, props] of [
  [
    '../src/background/BackgroundTab.tsx',
    'BackgroundTab',
    { place: { deviceId: 'd', sessionId: 's' } },
  ],
  [
    '../../../apps/mobile/src/screens/background/BackgroundScreen.tsx',
    'BackgroundScreen',
    { route: { params: { deviceId: 'd', sessionId: 's' } }, navigation: {} },
  ],
]) {
  test(`${name}：空任务页说明版本或未安装；开关关闭与已安装不误报`, async () => {
    const render = await component(new URL(path, import.meta.url).pathname, name)
    try {
      for (const [wake, expected] of [
        [{ enabled: true, installed: false, supported: false, version: '0.157.1' }, 'unsupported'],
        [{ enabled: true, installed: false, supported: true, version: '0.163.0' }, 'missing'],
        [{ enabled: false, installed: false, supported: true, version: '0.163.0' }, null],
        [{ enabled: true, installed: true, supported: true, version: '0.163.0' }, null],
      ]) {
        globalThis.__nativeBackgroundView = {
          entries: [],
          running: 0,
          wakesOnFinish: false,
          nativeWake: wake,
        }
        const note = nodes(render(props)).find(
          (n) =>
            n.props?.['data-background-native-hint'] !== undefined ||
            n.props?.testID === 'background:native-hint',
        )
        assert.equal(!!note, expected !== null)
        if (expected) assert.ok(note.props.children.includes(`background.native.${expected}`))
      }
    } finally {
      delete globalThis.__nativeBackgroundView
    }
  })
}
