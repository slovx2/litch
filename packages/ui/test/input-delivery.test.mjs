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

test('桌面消息的四种状态在读屏名称中，只有未落定状态在气泡左边画一个小图标', async () => {
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
      if (delivery && delivery !== 'sent') {
        assert.equal(status.props['data-delivery-status'], delivery)
        // 挂在气泡上、绝对定位到左边（transcript.css），不另起一行
        assert.ok(nodes(bubble).includes(status))
        // 只有图标，没有字；说明在悬停提示和读屏名称里
        assert.equal(
          nodes(status).some((node) => node !== status && node.type === 'span'),
          false,
        )
        assert.equal(status.props.role, 'img')
        assert.equal(status.props['aria-label'], `inputDelivery.${delivery}.note`)
        assert.equal(status.props.title, `inputDelivery.${delivery}.note`)
      } else assert.equal(status, undefined)
    }
  } finally {
    delete globalThis.__deliveryItem
  }
})

test('手机状态在气泡左边一窄列里，不在气泡里也不另起一行；读屏仍读正文和状态', async () => {
  const render = await component(
    new URL('../../../apps/mobile/src/detail/cells.tsx', import.meta.url).pathname,
    'UserCell',
  )
  for (const delivery of ['queued', 'held', 'unknown', 'sent', undefined]) {
    const row = { text: '正文', attachments: [], delivery }
    const result = render({ row })
    const bubble = nodes(result).find((node) => node.props?.testID === 'user-message')
    const mark = nodes(result).find((node) => node.props && 'delivery' in node.props)
    assert.equal(
      bubble.props.accessibilityLabel,
      delivery ? `message: inputDelivery.${delivery}. 正文` : undefined,
    )
    // 记号和气泡是同一排的兄弟：在气泡外面，也不在气泡下面另起一排
    assert.equal(nodes(bubble).includes(mark), false)
    assert.ok(result.props.children.flat().some((child) => nodes(child).includes(mark)))
    assert.equal(mark.props.delivery, delivery)
    // 复制收进长按菜单：气泡旁没有复制按钮
    assert.equal(
      nodes(result).some((node) => node.props && 'itemId' in node.props),
      false,
    )
  }
})

test('手机交付记号：已发送不画；其余只画记号，读屏名称和点一下的说明是整句', async () => {
  const render = await component(
    new URL('../../../apps/mobile/src/detail/DeliveryMark.tsx', import.meta.url).pathname,
    'DeliveryMark',
  )
  for (const delivery of ['sent', undefined, null]) assert.equal(render({ delivery }), null)
  for (const delivery of ['queued', 'held', 'unknown']) {
    let said = null
    const mark = render({ delivery, onPress: (note) => (said = note) })
    assert.equal(mark.props.testID, `input-delivery-${delivery}`)
    assert.equal(mark.props['aria-label'], `inputDelivery.${delivery}.note`)
    const glyph = nodes(mark).find((node) => node.type === 'Text').props.children
    assert.equal([glyph].flat().join('').length, 1)
    mark.props.onPress()
    assert.equal(said, `inputDelivery.${delivery}.note`)
    // 没给 onPress（输入框上方的待发列表）：不能点，读屏名称照样是整句
    assert.equal(render({ delivery }).props.disabled, true)
  }
})

test('手机待发：停止后一行头加每条一行图标按钮，不每行重复状态；只是排队时没有标题行', async () => {
  const render = await component(
    new URL('../../../apps/mobile/src/detail/composer/QueueTray.tsx', import.meta.url).pathname,
    'QueueTray',
  )
  const message = (id, delivery) => ({ id, text: id, images: [], extras: [], delivery })
  const props = (queued) => ({
    queued,
    running: queued.every((entry) => !entry.delivery),
    canSteer: true,
    steerImages: true,
    onSteer() {},
    onEdit() {},
    onRemove() {},
    onRefused() {},
    onResume() {},
  })
  const texts = (tree) =>
    nodes(tree)
      .filter((node) => node.type === 'Text')
      .flatMap((node) => [node.props.children].flat())
      .filter((child) => typeof child === 'string')
  const acts = (tree) => nodes(tree).filter((node) => node.props && 'glyph' in node.props)

  const held = render(props([message('a', 'held'), message('b', 'held')]))
  assert.ok(nodes(held).some((node) => node.props?.testID === 'queue:send'))
  assert.ok(texts(held).includes('composer.pendingSendAll'))
  // 状态词不在行里：没有“已停止待发”，也没有每行的状态记号
  assert.equal(
    texts(held).some((text) => text.includes('inputDelivery')),
    false,
  )
  assert.equal(
    nodes(held).some((node) => node.props && 'delivery' in node.props),
    false,
  )
  for (const index of [0, 1]) {
    const row = nodes(held).find((node) => node.props?.testID === `queue:${index}`)
    const icons = acts(row)
    assert.deepEqual(
      icons.map((node) => node.props.glyph),
      ['↑', '✎', '✕'],
    )
    // 每个图标按钮都有读屏名称（动作），不是只有记号
    assert.deepEqual(
      icons.map((node) => node.props.label),
      ['composer.send', 'composer.editQueued', 'composer.unqueue'],
    )
    // 单行：正文截断成一行
    assert.ok(nodes(row).some((node) => node.props?.numberOfLines === 1))
  }

  const queued = render(props([message('a'), message('b')]))
  assert.equal(
    nodes(queued).some((node) => node.props?.testID === 'queue:send'),
    false,
  )
  // 没有标题行：数目写在第一行前面
  assert.ok(texts(queued).includes('◷ 2'))
  assert.deepEqual(
    acts(nodes(queued).find((node) => node.props?.testID === 'queue:0')).map(
      (node) => node.props.label,
    ),
    ['composer.steer', 'composer.editQueued', 'composer.unqueue'],
  )

  // 说不准的那条：只在那一行标一个记号
  const unknown = render(props([message('a', 'held'), message('b', 'unknown')]))
  assert.deepEqual(
    nodes(unknown)
      .filter((node) => node.props && 'delivery' in node.props)
      .map((node) => node.props.delivery),
    ['unknown'],
  )
})
