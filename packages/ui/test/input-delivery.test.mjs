import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { build } from '../../../node_modules/esbuild/lib/main.js'

// 执行正式消息组件，仅替换订阅、调度和未展开的子组件；检查气泡与状态的父子关系。
async function component(path, name) {
  const source = readFileSync(path, 'utf8')
  const imports = new Map(
    [...source.matchAll(/import\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/g)].map((match) => [
      match[2],
      match[1]
        .split(',')
        .map((part) => part.trim())
        .filter((part) => part && !part.startsWith('type ')),
    ]),
  )
  const values = {
    memo: 'f=>f',
    useEffect: '()=>{}',
    useMemo: 'f=>f()',
    useState: 'x=>[x,()=>{}]',
    useRef: 'x=>({current:x})',
    useToggle: '()=>[false,()=>{}]',
    usePin: '()=>()=>{}',
    useKey: '()=>globalThis.__deliveryItem',
    useServices: '()=>({replica:{store:{get:()=>undefined}}})',
    useT: '()=>((key,args)=>args?.status ? `message: ${args.status}` : key)',
    useTheme: '()=>({c:{},font:{size:{}},radius:{}})',
    useTranscript: '()=>({turnMenu:()=>{}})',
    useToggleInPlace: '()=>()=>{}',
    StyleSheet: '{create:x=>x}',
    keys: '{item:()=>"item"}',
    Pressable: '"Pressable"',
    View: '"View"',
    Text: '"Text"',
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
        name: 'message-fixture',
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
  const module = await import(
    `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`
  )
  return module[name]
}

const nodes = (node) =>
  !node || typeof node !== 'object'
    ? []
    : Array.isArray(node)
      ? node.flatMap(nodes)
      : [node, ...nodes(node.props?.children)]

test('桌面消息的四种状态在读屏名称中，只有未落定状态显示在气泡外', async () => {
  const render = await component(
    new URL('../src/transcript/messages.tsx', import.meta.url).pathname,
    'UserMessage',
  )
  try {
    for (const delivery of ['queued', 'held', 'unknown', 'sent', undefined]) {
      globalThis.__deliveryItem = { kind: 'userMessage', text: '正文', attachments: [], delivery }
      const result = render({ deviceId: 'd', sessionId: 's', itemId: 'i' })
      const bubble = nodes(result).find((node) => node.props?.className === 'umsg')
      const status = nodes(result).find((node) => node.props?.className === 'umsg-delivery')
      assert.ok(bubble)
      assert.equal(bubble.props['data-input-delivery'], delivery)
      assert.equal(
        bubble.props['aria-label'],
        delivery ? `message: inputDelivery.${delivery}` : undefined,
      )
      assert.equal(
        nodes(bubble).some((node) => node.props?.['data-delivery-status']),
        false,
      )
      if (delivery && delivery !== 'sent') {
        assert.equal(status.props['data-delivery-status'], delivery)
        assert.equal(
          nodes(status).find((node) => node.type === 'span').props.children[0],
          `inputDelivery.${delivery}`,
        )
      } else assert.equal(status, undefined)
    }
  } finally {
    delete globalThis.__deliveryItem
  }
})

test('手机状态在气泡下方，已发送无可见状态，读屏仍读正文和状态', async () => {
  const render = await component(
    new URL('../../../apps/mobile/src/detail/cells.tsx', import.meta.url).pathname,
    'UserCell',
  )
  for (const delivery of ['queued', 'held', 'unknown', 'sent', undefined]) {
    const row = { text: '正文', attachments: [], delivery }
    const result = render({ row })
    const bubble = nodes(result).find((node) => node.props?.testID === 'user-message')
    const status = nodes(result).find((node) => node.props?.testID?.startsWith('input-delivery-'))
    assert.equal(
      bubble.props.accessibilityLabel,
      delivery ? `message: inputDelivery.${delivery}. 正文` : undefined,
    )
    assert.equal(nodes(bubble).includes(status), false)
    assert.equal(
      status?.props.testID,
      delivery && delivery !== 'sent' ? `input-delivery-${delivery}` : undefined,
    )
  }
})
