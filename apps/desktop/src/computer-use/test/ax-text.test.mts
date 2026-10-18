// 界面树编号与差异（ax-text.mts）：规则对照 macOS 助手的 AXText.swift 和它的测试。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AXIndexBook, cut, describe, diff, isShown, render } from '../ax-text.mjs'
import type { WinNode } from '../wire.mjs'

function node(role: string, extra: Partial<WinNode> = {}, children: WinNode[] = []): WinNode {
  return { ref: '', role, states: [], actions: [], children, ...extra }
}

function notepad(text: string, extraButton = false): WinNode {
  return node('Window', { ref: '1', name: 'Untitled - Notepad' }, [
    node('Pane', { ref: '2' }, [
      node('MenuBar', { ref: '3', name: 'Application' }, [
        node('MenuItem', { ref: '4', name: 'File' }),
        node('MenuItem', { ref: '5', name: 'Edit' }),
      ]),
      node('Document', { ref: '6', name: 'Text editor', value: text, states: ['focused'] }),
      ...(extraButton ? [node('Button', { ref: '7', name: 'Save' })] : []),
    ]),
  ])
}

test('排成文字：没有名字的容器不单占一行，孩子提上来；角色、名字、值、状态', () => {
  const book = new AXIndexBook()
  const lines = book.lines(notepad('hello'))
  assert.equal(
    render(lines),
    [
      '[1] Window "Untitled - Notepad"',
      '  [2] MenuBar "Application"',
      '    [3] MenuItem "File"',
      '    [4] MenuItem "Edit"',
      '  [5] Document "Text editor" = "hello" {focused}',
    ].join('\n'),
  )
  assert.equal(lines[4]?.ref, '6')
})

test('同一个元素前后号码不变；新出现的给新号，号码不重用；差异只列变了的', () => {
  const book = new AXIndexBook()
  book.remember(book.lines(notepad('hello')))
  const next = book.lines(notepad('hello world', true))
  assert.equal(
    diff(book.previous, next),
    ['~ [5] Document "Text editor" = "hello world" {focused}', '+ [6] Button "Save"'].join('\n'),
  )
  book.remember(next)
  // Save 消失，再出现时是新号
  const gone = book.lines(notepad('hello world'))
  assert.equal(diff(book.previous, gone), '- [6] Button "Save"')
  book.remember(gone)
  const back = book.lines(notepad('hello world', true))
  assert.equal(back.at(-1)?.index, 7)
  book.remember(back)
  assert.equal(diff(book.previous, back), '(no changes since the last state)')
})

test('按 ref 认元素：名字变了、挪了位置号码照旧', () => {
  const book = new AXIndexBook()
  const first = book.lines(
    node('Window', { ref: 'w' }, [
      node('Button', { ref: 'a', name: 'One' }),
      node('Button', { ref: 'b', name: 'Two' }),
    ]),
  )
  book.remember(first)
  const second = book.lines(
    node('Window', { ref: 'w' }, [
      node('Button', { ref: 'b', name: 'Two' }),
      node('Button', { ref: 'a', name: 'Uno' }),
    ]),
  )
  assert.deepEqual(
    second.map((line) => [line.index, line.ref]),
    [
      [1, 'w'],
      [3, 'b'],
      [2, 'a'],
    ],
  )
  assert.equal(diff(book.previous, second), '~ [2] Button "Uno"')
})

test('ref 变了（Chromium 重建节点）退回按路径认；一个号码一次只给一个元素', () => {
  const book = new AXIndexBook()
  book.remember(
    book.lines(node('Window', { ref: 'w' }, [node('Button', { ref: 'old', name: 'Go' })])),
  )
  const rebuilt = book.lines(
    node('Window', { ref: 'w' }, [node('Button', { ref: 'new', name: 'Go' })]),
  )
  assert.equal(rebuilt[1]?.index, 2)
  assert.equal(rebuilt[1]?.ref, 'new')
  // 撞号：旧的 a 按 ref 认是 2，一个没 ref 的同路径元素也想要 2
  const clash = new AXIndexBook()
  clash.lines(node('Window', { ref: 'w' }, [node('Button', { ref: 'a', name: 'X' })]))
  const both = clash.lines(
    node('Window', { ref: 'w' }, [
      node('Button', { ref: '', name: 'X' }),
      node('Button', { ref: 'a', name: 'Y' }),
    ]),
  )
  const indexes = both.map((line) => line.index)
  assert.equal(new Set(indexes).size, indexes.length, `号码重了：${indexes}`)
})

test('同名兄弟按先后区分；没有 ref 时按路径认', () => {
  const book = new AXIndexBook()
  const tree = () =>
    node('Window', {}, [node('ListItem', { name: 'Row' }), node('ListItem', { name: 'Row' })])
  const one = book.lines(tree())
  const two = book.lines(tree())
  assert.deepEqual(
    one.map((line) => line.index),
    two.map((line) => line.index),
  )
  assert.equal(new Set(one.map((line) => line.index)).size, 3)
})

test('描述：值和名字一样不重复写，换行和引号转义，过长截断；密码框只有状态', () => {
  assert.equal(describe(node('Text', { name: 'Hi', value: 'Hi' })), 'Text "Hi"')
  assert.equal(describe(node('Edit', { name: 'a"b', value: 'x\ny\r' })), 'Edit "a\\"b" = "x\\ny"')
  assert.equal(
    describe(node('Edit', { name: 'Password', states: ['password'] })),
    'Edit "Password" {password}',
  )
  const long = describe(node('Text', { name: '字'.repeat(130) }))
  assert.equal(long, `Text "${'字'.repeat(120)}…"`)
  assert.equal(isShown(node('Pane')), false)
  assert.equal(isShown(node('Pane', { automationId: 'sidebar' })), true)
  assert.equal(isShown(node('Group', { name: 'Tools' })), true)
})

test('截断：在行与行之间截，说明省了几行；没有上一次时差异是 null', () => {
  assert.equal(cut(['aaaa', 'bbbb', 'cccc'], 10), 'aaaa\nbbbb\n… (1 more lines not shown)')
  // 第一行再长也留着
  assert.equal(cut(['x'.repeat(50)], 10), 'x'.repeat(50))
  assert.equal(diff(null, []), null)
  const book = new AXIndexBook()
  const many = node(
    'Window',
    {},
    Array.from({ length: 2000 }, (_, i) => node('ListItem', { ref: `r${i}`, name: `Item ${i}` })),
  )
  const text = render(book.lines(many), 4000)
  assert.ok([...text].length <= 4000 + 60)
  assert.match(text, /more lines not shown\)$/)
})
