// 执行两端正式组件；替换框架订阅和平台外壳，检查清理状态与点击行为。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { build } from '../../../node_modules/esbuild/lib/main.js'

async function renderFileCard(path) {
  const source = readFileSync(path, 'utf8')
  const imports = new Map(
    [...source.matchAll(/import\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/g)].map((m) => [
      m[2],
      m[1]
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s && !s.startsWith('type ')),
    ]),
  )
  const values = {
    attachmentDetail: '()=>"PDF · 1 KB"',
    attachmentState: 'async()=>globalThis.__attachmentNext',
    useEffect: '()=>{}',
    useState:
      'x=>[x==="unknown"?globalThis.__attachmentShown:x,v=>{globalThis.__attachmentUpdated=v}]',
    useKey: 'key=>key==="devices"?[]:({connection:"online"})',
    useKeys: '()=>[]',
    useServices:
      '()=>({channel:{command:()=>{globalThis.__attachmentRequests++;throw new Error("不应打开已清理文件")}},replica:{store:{get:()=>null}}})',
    useT: '()=>key=>key',
    useTheme: '()=>({c:{},radius:{},font:{size:{}}})',
    keys: '{device:x=>x,devices:"devices",summary:()=>"summary"}',
    StyleSheet: '{create:x=>x}',
    Pressable: '"Pressable"',
    Text: '"Text"',
    View: '"View"',
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
        name: 'file-card-fixture',
        setup(api) {
          api.onResolve({ filter: /.*/ }, (args) =>
            imports.has(args.path) ? { path: args.path, namespace: 'fixture' } : undefined,
          )
          api.onLoad({ filter: /.*/, namespace: 'fixture' }, (args) => ({
            contents: imports
              .get(args.path)
              .map((key) => `export const ${key}=${values[key] ?? '()=>null'};`)
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
  ).FileCard
}
const nodes = (n) =>
  !n || typeof n !== 'object'
    ? []
    : Array.isArray(n)
      ? n.flatMap(nodes)
      : [n, ...nodes(n.props?.children)]
const words = (n) =>
  typeof n === 'string'
    ? n
    : !n || typeof n !== 'object'
      ? ''
      : Array.isArray(n)
        ? n.map(words).join('')
        : words(n.props?.children)
for (const [platform, path] of [
  ['desktop', new URL('../src/transcript/FileCard.tsx', import.meta.url).pathname],
  ['mobile', new URL('../../../apps/mobile/src/detail/FileCard.tsx', import.meta.url).pathname],
])
  test(`${platform} 文件卡显示已清理，点击时发现刚清理的文件也不继续预览`, async () => {
    const render = await renderFileCard(path)
    const props = {
      deviceId: 'remote',
      file: {
        kind: 'file',
        label: '报告.pdf',
        path: '/home/u/.litch/attachments/mabcdefg-abcdefgh-12345678/report.pdf',
      },
      onPress: () => {
        globalThis.__attachmentRequests++
      },
    }
    globalThis.__attachmentShown = 'cleaned'
    globalThis.__attachmentRequests = 0
    const cleaned = render(props)
    assert.match(words(cleaned), /attachment.cleaned/)
    const button = nodes(cleaned).find((n) => n.type === 'button' || n.type === 'Pressable')
    assert.equal(button.props.disabled, true)
    globalThis.__attachmentShown = 'unknown'
    globalThis.__attachmentNext = 'cleaned'
    const stale = render(props)
    const staleButton = nodes(stale).find((n) => n.type === 'button' || n.type === 'Pressable')
    ;(staleButton.props.onClick ?? staleButton.props.onPress)()
    await new Promise((r) => setImmediate(r))
    assert.equal(globalThis.__attachmentUpdated, 'cleaned')
    assert.equal(globalThis.__attachmentRequests, 0)
  })
