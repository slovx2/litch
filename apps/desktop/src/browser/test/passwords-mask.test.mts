// 代理读不到密码：快照里密码框的值遮住、evaluate 的结果里密码框的值替掉、type 之后不回报密码框的值。
// 纯函数直接测，工具经执行器加一个假的页面测（不起 Electron）。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ClientToolCallResponse } from '../../../../../packages/protocol/src/client-tools.mjs'
import { type AxNode, formatAxTree, newRefBook } from '../ax.mjs'
import { CdpRefused, isAllowedCdp } from '../cdp-allow.mjs'
import { createBrowserExecutor } from '../executor.mjs'
import type { BrowserHost, BrowserPage, TabInfo, TabKind, TabOwner } from '../model.mjs'
import {
  COLLECT_PASSWORDS,
  fieldNodes,
  isPasswordNode,
  MASKED,
  maskAxNodes,
  READ_FIELD_VALUE,
  redactSecrets,
} from '../passwords/mask.mjs'
import { createSiteBook } from '../sites.mjs'

const SECRET = 'hunter2-secret'

/** 一个登录页的无障碍树：邮箱框、密码框（里面还有一个文字节点）、按钮 */
const LOGIN_TREE: AxNode[] = [
  { nodeId: '1', role: { value: 'RootWebArea' }, childIds: ['2', '3', '5'] },
  {
    nodeId: '2',
    parentId: '1',
    role: { value: 'textbox' },
    name: { value: 'Email' },
    value: { value: 'ann@example.com' },
    backendDOMNodeId: 12,
  },
  {
    nodeId: '3',
    parentId: '1',
    role: { value: 'textbox' },
    name: { value: 'Password' },
    value: { value: SECRET },
    childIds: ['4'],
    backendDOMNodeId: 11,
  },
  { nodeId: '4', parentId: '3', role: { value: 'StaticText' }, name: { value: SECRET } },
  { nodeId: '5', parentId: '1', role: { value: 'button' }, name: { value: 'Sign in' } },
]

test('认密码框：看 DOM 节点的 type 和 autocomplete', () => {
  assert.equal(isPasswordNode({ nodeName: 'INPUT', attributes: ['type', 'password'] }), true)
  assert.equal(
    isPasswordNode({ nodeName: 'input', attributes: ['id', 'x', 'TYPE', ' Password '] }),
    true,
  )
  assert.equal(isPasswordNode({ nodeName: 'INPUT', attributes: ['type', 'text'] }), false)
  assert.equal(isPasswordNode({ nodeName: 'INPUT', attributes: [] }), false)
  assert.equal(isPasswordNode({ nodeName: 'DIV', attributes: ['type', 'password'] }), false)
  // 人点了“显示密码”成了 text，但 autocomplete 写着是密码、验证码的也算
  for (const token of ['current-password', 'new-password', 'section-x one-time-code'])
    assert.equal(
      isPasswordNode({ nodeName: 'INPUT', attributes: ['type', 'text', 'autocomplete', token] }),
      true,
    )
  assert.equal(
    isPasswordNode({ nodeName: 'INPUT', attributes: ['type', 'text', 'autocomplete', 'username'] }),
    false,
  )
  assert.deepEqual(fieldNodes(LOGIN_TREE), [12, 11])
})

test('快照排版前遮住密码框的值和它下面的文字', () => {
  const lines = formatAxTree(maskAxNodes(LOGIN_TREE, new Set([11])), newRefBook()).join('\n')
  assert.equal(lines.includes(SECRET), false)
  assert.match(lines, new RegExp(`textbox "Password" value="${MASKED}"`))
  assert.match(lines, /textbox "Email" value="ann@example.com"/)
  // 原来的节点表不动
  assert.equal(LOGIN_TREE[2]?.value?.value, SECRET)
})

test('结果里替掉密码框的值，含 JSON 转义过的写法；太短的不替', () => {
  const tricky = 'a"b\\c'
  const text = JSON.stringify({ a: SECRET, b: `x${SECRET}y`, c: tricky, d: 'ab' })
  const out = redactSecrets(text, [SECRET, tricky, 'ab', 42])
  assert.equal(out.includes(SECRET), false)
  assert.equal(out.includes('a\\"b\\\\c'), false)
  assert.match(out, /"d":"ab"/)
  assert.equal(redactSecrets('nothing here', []), 'nothing here')
})

test('type 之后读框里的值：密码框只回遮罩', () => {
  class FakeInput {
    type = 'password'
    value = SECRET
  }
  const scope = globalThis as unknown as { HTMLInputElement?: unknown }
  const before = scope.HTMLInputElement
  scope.HTMLInputElement = FakeInput
  try {
    const read = new Function(`return ${READ_FIELD_VALUE}`)() as (this: unknown) => string
    assert.equal(read.call(new FakeInput()), MASKED)
    const empty = new FakeInput()
    empty.value = ''
    assert.equal(read.call(empty), '')
    const plain = new FakeInput()
    plain.type = 'email'
    plain.value = 'ann@example.com'
    assert.equal(read.call(plain), 'ann@example.com')
    // 显示出来的密码（type 成了 text，autocomplete 还写着）照样遮
    const shown = Object.assign(new FakeInput(), { type: 'text', autocomplete: 'current-password' })
    assert.equal(read.call(shown), MASKED)
  } finally {
    scope.HTMLInputElement = before
  }
})

/** 只有一个页面的假宿主：登录页，密码框里填着 SECRET */
function loginHost() {
  const pages = new Map<string, BrowserPage>()
  let seq = 0
  const host: BrowserHost = {
    pages: () => [...pages.values()],
    page: (id) => pages.get(id),
    open(owner: TabOwner, kind: TabKind) {
      const id = `t${++seq}`
      let url = 'about:blank'
      const page: BrowserPage = {
        id,
        info: (): TabInfo => ({
          id,
          owner,
          kind,
          url,
          title: 'Sign in',
          loading: false,
          canGoBack: false,
          canGoForward: false,
          agentActive: false,
          keep: false,
        }),
        async load(next) {
          url = next
          return { ok: true }
        },
        history: async () => ({ ok: true }),
        waitForLoad: async () => true,
        async cdp<T>(method: string, params?: Record<string, unknown>): Promise<T> {
          if (!isAllowedCdp(method)) throw new CdpRefused(method)
          if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'f', url } } } as T
          if (method === 'Accessibility.getFullAXTree') return { nodes: LOGIN_TREE } as T
          if (method === 'DOM.describeNode') {
            const type = params?.backendNodeId === 11 ? 'password' : 'email'
            return { node: { nodeName: 'INPUT', attributes: ['type', type] } } as T
          }
          if (method === 'Runtime.evaluate') {
            if (params?.expression === COLLECT_PASSWORDS)
              return { result: { value: [SECRET] } } as T
            return {
              result: { type: 'object', value: { pw: SECRET, user: 'ann@example.com' } },
            } as T
          }
          return {} as T
        },
        consoleEntries: () => [],
        clearConsole() {},
        dialog: () => null,
        dialogOpened: () => new Promise(() => {}),
        takeNotices: () => [],
        setAgentActive() {},
        pointAt: async () => {},
      }
      pages.set(id, page)
      return page
    },
    close: (id) => void pages.delete(id),
    setKeep() {},
    release() {},
    show() {},
    setNavigationGate() {},
  }
  return host
}

const text = (reply: ClientToolCallResponse) =>
  reply.contentItems.map((item) => (item.type === 'inputText' ? item.text : '')).join('\n')

test('读页工具交给模型的东西里没有密码框的值', async () => {
  const executor = createBrowserExecutor({ host: loginHost(), sites: createSiteBook(null) })
  let seq = 0
  const run = (tool: string, args: unknown = {}) =>
    executor.call(
      {
        id: `i${++seq}`,
        threadId: 'a',
        turnId: 'turn-1',
        callId: `c${seq}`,
        namespace: 'litch_browser',
        tool,
        arguments: args,
        device: { id: 'local', name: 'Mac', kind: 'local', target: null },
        harness: 'pi',
        cwd: null,
      },
      { signal: new AbortController().signal, ask: async () => null },
    )
  assert.equal((await run('navigate', { url: 'http://localhost:3000/login' })).success, true)
  const snapshot = text(await run('snapshot'))
  assert.equal(snapshot.includes(SECRET), false)
  assert.match(snapshot, /textbox "Password" value="••••••"/)
  assert.match(snapshot, /ann@example.com/)
  const evaluated = text(await run('evaluate', { expression: 'document.forms[0]' }))
  assert.equal(evaluated.includes(SECRET), false)
  assert.match(evaluated, /"pw":"••••••"/)
  assert.match(evaluated, /ann@example.com/)
})
