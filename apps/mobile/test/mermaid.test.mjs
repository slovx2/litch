// mermaid 卡片的纯逻辑：拆块（src/detail/mermaid/segments.ts）、配色（look.ts）、排队和缓存（drawer.ts）
import assert from 'node:assert/strict'
import { after, mock, test } from 'node:test'
import { drawKey, MermaidDrawer, TIMED_OUT } from '../src/detail/mermaid/drawer.ts'
import { channels, mermaidLook, toHex } from '../src/detail/mermaid/look.ts'
import { splitMermaid } from '../src/detail/mermaid/segments.ts'
import { PALETTES } from '../src/ui/palettes.ts'

test('写完的 mermaid 块拆出来，前后的字照旧；别的代码块不动', () => {
  const text = [
    '看图：',
    '',
    '```mermaid',
    'flowchart LR',
    '  A --> B',
    '```',
    '',
    '```ts',
    'const a = 1',
    '```',
  ].join('\n')
  assert.deepEqual(splitMermaid(text), [
    { kind: 'md', at: 0, text: '看图：' },
    { kind: 'mermaid', at: 2, source: 'flowchart LR\n  A --> B' },
    { kind: 'md', at: 6, text: '```ts\nconst a = 1\n```' },
  ])
})

test('没写完的 mermaid 块留在字里，照源码显示；写完了才拆出来，前面那段的 at 不变', () => {
  const head = ['开头', '', '```mermaid', 'flowchart LR', '  A --> B']
  assert.deepEqual(splitMermaid(head.join('\n')), [{ kind: 'md', at: 0, text: head.join('\n') }])
  const done = splitMermaid([...head, '```', '', '结尾'].join('\n'))
  assert.deepEqual(
    done.map((each) => [each.kind, each.at]),
    [
      ['md', 0],
      ['mermaid', 2],
      ['md', 6],
    ],
  )
})

test('别的代码块里写着的 ```mermaid 不算；没有 mermaid 的原样一段；~~~ 围栏和大小写也认', () => {
  const nested = ['````md', '```mermaid', 'x', '```', '````'].join('\n')
  assert.deepEqual(splitMermaid(nested), [{ kind: 'md', at: 0, text: nested }])
  assert.deepEqual(splitMermaid('普通的话'), [{ kind: 'md', at: 0, text: '普通的话' }])
  assert.deepEqual(splitMermaid('~~~Mermaid\npie\n~~~'), [
    { kind: 'mermaid', at: 0, source: 'pie' },
  ])
})

test('配色：带透明度的线色叠到代码块底色上，写成不透明的十六进制；同一套配色同一份配置', () => {
  assert.deepEqual(channels('#1a1a14'), [26, 26, 20, 1])
  assert.deepEqual(channels('rgba(26,26,20,0.5)'), [26, 26, 20, 0.5])
  assert.equal(toHex([0, 0, 0, 0.5], [255, 255, 255]), '#808080')
  const makeTheme = (skin, dark) => ({
    skin,
    dark,
    c: PALETTES[skin][dark ? 'dark' : 'light'],
    font: { ui: skin === 'human' ? 'serif' : undefined },
  })
  for (const skin of ['retro', 'human', 'standard']) {
    for (const dark of [false, true]) {
      const theme = makeTheme(skin, dark)
      const look = mermaidLook(theme)
      assert.equal(look.key, `${skin}:${dark ? 'dark' : 'light'}`)
      assert.equal(mermaidLook(theme), look)
      const vars = look.config.themeVariables
      for (const [name, value] of Object.entries(vars)) {
        if (typeof value === 'string' && !['fontFamily', 'fontSize', 'dropShadow'].includes(name))
          assert.match(value, /^#[0-9a-f]{6}$/, `${skin}:${dark} ${name}`)
      }
      assert.equal(vars.background, theme.c.sunken.toLowerCase())
      assert.equal(look.config.htmlLabels, false)
      assert.equal(look.config.securityLevel, 'strict')
    }
  }
  assert.equal(mermaidLook(makeTheme('human', false)).config.fontFamily.includes('serif'), true)
})

// 排队里的计时（超时、闲了撤页面）一律走假时钟，测试不用真等
mock.timers.enable({ apis: ['setTimeout'] })
after(() => mock.timers.reset())

const box = { width: 300, height: 184, scale: 3, max: 1.25 }
const job = (source) => ({
  key: drawKey('retro:light', box, source),
  source,
  config: {},
  box,
})
const drawn = (id, svg = `<svg>${id}</svg>`) => ({
  t: 'drawn',
  id,
  svg,
  png: 'data:image/png;base64,AA',
  width: 10,
  height: 5,
})

/** 一个替身页面：记下交过来的 */
function page(drawer) {
  const sent = []
  drawer.pageReady((message) => sent.push(message))
  return sent
}

test('要画时才开页面；一次交一张，后要的先画；画好经 watch 回来并记住', () => {
  {
    const drawer = new MermaidDrawer()
    assert.equal(drawer.hostState().wanted, false)
    const a = job('A')
    const b = job('B')
    const c = job('C')
    const seen = []
    for (const each of [a, b, c]) drawer.watch(each.key, (d) => seen.push([each.source, d]))
    drawer.request(a)
    assert.equal(drawer.hostState().wanted, true)
    drawer.request(b)
    drawer.request(c)
    const sent = page(drawer)
    assert.deepEqual(
      sent.map((m) => m.source),
      ['C'],
    )
    drawer.receive(drawn(sent[0].id))
    assert.deepEqual(
      sent.map((m) => m.source),
      ['C', 'B'],
    )
    drawer.receive({ t: 'failed', id: sent[1].id, reason: 'Parse error on line 2:' })
    drawer.receive(drawn(sent[2].id))
    assert.deepEqual(
      seen.map(([source, d]) => [source, 'error' in d ? d.error : d.svg]),
      [
        ['C', '<svg>1</svg>'],
        ['B', 'Parse error on line 2:'],
        ['A', '<svg>3</svg>'],
      ],
    )
    // 画过的（包括画不出来的）不再画
    assert.deepEqual(drawer.peek(b.key), { error: 'Parse error on line 2:' })
    drawer.request(b)
    assert.equal(sent.length, 3)
    // 闲了一分钟撤掉页面
    mock.timers.tick(60_000)
    assert.equal(drawer.hostState().wanted, false)
  }
})

test('撤回：没有卡片要了、还没开始画的不画；两张卡片要同一张，撤回一张照样画', () => {
  const drawer = new MermaidDrawer()
  const a = job('A')
  const b = job('B')
  const withdrawA = drawer.request(a)
  const first = drawer.request(b)
  drawer.request(b)
  first()
  withdrawA()
  withdrawA()
  const sent = page(drawer)
  assert.deepEqual(
    sent.map((m) => m.source),
    ['B'],
  )
  drawer.receive(drawn(sent[0].id))
  assert.equal(sent.length, 1)
})

test('最多记 keep 张，久没用的先丢', () => {
  const drawer = new MermaidDrawer({ keep: 2 })
  const sent = page(drawer)
  for (const source of ['A', 'B']) {
    drawer.request(job(source))
    drawer.receive(drawn(sent.at(-1).id))
  }
  drawer.peek(job('A').key)
  drawer.request(job('C'))
  drawer.receive(drawn(sent.at(-1).id))
  assert.ok(drawer.peek(job('A').key))
  assert.equal(drawer.peek(job('B').key), undefined)
  assert.ok(drawer.peek(job('C').key))
})

test('画太久：告诉卡片超时、不记，页面重开；旧页面晚到的结果不认；重开后接着画排着的', () => {
  {
    const drawer = new MermaidDrawer({ timeoutMs: 1000 })
    const a = job('A')
    const b = job('B')
    const seen = []
    drawer.watch(a.key, (d) => seen.push(d))
    drawer.request(b)
    drawer.request(a)
    const sent = page(drawer)
    const generation = drawer.hostState().generation
    mock.timers.tick(1000)
    assert.deepEqual(seen, [{ error: TIMED_OUT }])
    assert.equal(drawer.peek(a.key), undefined)
    assert.equal(drawer.hostState().generation, generation + 1)
    drawer.receive(drawn(sent[0].id))
    assert.equal(drawer.peek(a.key), undefined)
    const again = page(drawer)
    assert.deepEqual(
      again.map((m) => m.source),
      ['B'],
    )
  }
})

test('页面没了（撤掉、渲染进程崩了）：正在画的那张有人等着就放回去，重开后接着画', () => {
  const drawer = new MermaidDrawer()
  const a = job('A')
  const stop = drawer.watch(a.key, () => {})
  drawer.request(a)
  const sent = page(drawer)
  assert.equal(sent.length, 1)
  drawer.pageCrashed()
  assert.equal(drawer.hostState().generation, 1)
  const again = page(drawer)
  assert.deepEqual(
    again.map((m) => m.source),
    ['A'],
  )
  // 没人等着的不放回去
  stop()
  drawer.pageGone()
  assert.equal(page(drawer).length, 0)
})
