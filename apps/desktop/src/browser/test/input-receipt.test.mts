import assert from 'node:assert/strict'
import test from 'node:test'
import {
  type InputState,
  observedInput,
  receiptUrl,
} from '../../../../../packages/browser/src/browser/input-receipt.mjs'
import type { Call, Tool } from '../executor.mjs'
import type { BrowserPage } from '../model.mjs'
import { inputReady } from '../page-ops.mjs'
import { type as typeTool } from '../tools-act.mjs'

const state = (): InputState => ({
  url: 'https://fixture.test/a?token=private#secret',
  title: 'Fixture',
  dom: 1,
  document: 1,
  focus: { tag: 'BODY', role: null, id: null, value: null, checked: null },
  scroll: [0, 0],
  ready: 'complete',
})
function fixture(work: (current: InputState) => void) {
  const current = state()
  let sent = 0
  let rejectRead = false
  const page = {
    id: 'test',
    info: () => ({ url: current.url, loading: false }),
    dialog: () => null,
    cdp: async (method: string) => {
      if (method.startsWith('Input.')) {
        sent++
        work(current)
        return {}
      }
      if (rejectRead) throw Error('The lease was revoked')
      return { result: { value: structuredClone(current) } }
    },
    prepareObservation: async () => {},
    takeNotices: () => [],
  } as unknown as BrowserPage
  const call = {
    pick: () => page,
    context: { signal: new AbortController().signal },
    args: {},
    invocation: { tool: 'click' },
  } as unknown as Call
  const tool: Tool = async (call) => {
    await call.pick().cdp('Input.dispatchMouseEvent')
    return { success: true, contentItems: [{ type: 'inputText', text: 'Clicked' }] }
  }
  return {
    call,
    tool,
    sent: () => sent,
    rejectRead: () => {
      rejectRead = true
    },
  }
}
const receipt = (value: Awaited<ReturnType<Tool>>) => {
  const item = value.contentItems.find(
    (item) => item.type === 'inputText' && item.text.startsWith('{"inputReceipt"'),
  )
  assert.ok(item?.type === 'inputText')
  return JSON.parse(item.text).inputReceipt
}

test('有变化只证明观察结果；新回执不输出查询、片段、DOM 内容或哈希', async () => {
  const f = fixture((current) => {
    current.dom++
    current.focus.value = 'public value'
  })
  const result = await observedInput(f.tool)(f.call)
  assert.equal(result.success, true)
  const r = receipt(result)
  assert.equal(r.dispatch, 'dispatched')
  assert.equal(r.observation, 'changed')
  assert.equal(r.businessOutcome, 'unknown')
  assert.equal(r.before.url, 'https://fixture.test/a')
  assert.equal(r.before.dom, undefined)
  assert.doesNotMatch(JSON.stringify(result), /token=private|#secret|Clicked/)
  assert.equal(f.sent(), 1)
})

test('没有变化仍可合法派发；回执明确 unchanged，不能当业务完成', async () => {
  const f = fixture(() => {})
  const r = receipt(await observedInput(f.tool)(f.call))
  assert.equal(r.dispatch, 'dispatched')
  assert.equal(r.observation, 'unchanged')
  assert.equal(r.businessOutcome, 'unknown')
})

test('导航回执删除操作期间的旧标签行，保留来源与弹窗提示', async () => {
  const f = fixture((current) => {
    current.url = 'https://fixture.test/new'
  })
  const tool: Tool = async (call) => {
    await call.pick().cdp('Input.dispatchMouseEvent')
    return {
      success: true,
      contentItems: [
        {
          type: 'inputText',
          text: 'Clicked\nTab test: Old — https://fixture.test/obsolete\nNotices: popup blocked',
        },
      ],
    }
  }
  const result = await observedInput(tool)(f.call)
  assert.equal(receipt(result).destination, 'https://fixture.test/new')
  assert.doesNotMatch(JSON.stringify(result), /obsolete|Tab test/)
  assert.match(JSON.stringify(result), /Notices: popup blocked/)
})

test('派发后观察被撤销，保存派发状态且不重发', async () => {
  const f = fixture(() => f.rejectRead())
  const result = await observedInput(f.tool)(f.call)
  const r = receipt(result)
  assert.equal(result.success, true)
  assert.equal(r.dispatch, 'dispatched')
  assert.equal(r.observation, 'unavailable')
  assert.match(r.observationError, /revoked/)
  assert.equal(f.sent(), 1)
})

test('点击已跳转后旧文档失败恢复为导航回执，不执行第二次输入', async () => {
  const f = fixture((current) => {
    current.url = 'https://fixture.test/new'
    current.dom++
  })
  const tool: Tool = async (call) => {
    await call.pick().cdp('Input.dispatchMouseEvent')
    throw Error('The document changed after dispatch')
  }
  const result = await observedInput(tool)(f.call)
  assert.equal(result.success, true)
  assert.equal(receipt(result).navigation, true)
  assert.equal(f.sent(), 1)
})

test('焦点确认超时不吞掉；URL 长凭据段不出回执', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const pending = inputReady({ cdp: () => new Promise(() => {}) } as unknown as BrowserPage)
  const rejected = assert.rejects(pending, /did not confirm input focus/)
  t.mock.timers.tick(1200)
  await rejected
  assert.equal(
    receiptUrl(`https://a.test/${'s'.repeat(40)}?sig=secret`),
    'https://a.test/[redacted]',
  )
})

test('同 URL 重载也按新文档恢复，执行上下文消失不能误报未派发', async () => {
  const f = fixture((current) => {
    current.document++
  })
  const tool: Tool = async (call) => {
    await call.pick().cdp('Input.dispatchMouseEvent')
    throw Error('Execution context was destroyed')
  }
  const result = await observedInput(tool)(f.call)
  assert.equal(result.success, true)
  assert.equal(receipt(result).navigation, true)
  assert.ok(receipt(result).changes.includes('document'))
  assert.equal(receipt(result).after.document, undefined)
  assert.equal(f.sent(), 1)
})

test('普通字段未获得焦点时明确拒绝，不派发文字', async () => {
  const f = fixture(() => {})
  const page = f.call.pick()
  const original = page.cdp.bind(page)
  page.cdp = async <T,>(method: string): Promise<T> => {
    if (method === 'DOM.resolveNode') return { object: { objectId: 'field' } } as T
    if (method === 'Runtime.callFunctionOn')
      return { result: { value: { kind: 'field', ok: false } } } as T
    return original<T>(method)
  }
  const result = await typeTool({
    ...f.call,
    invocation: { ...f.call.invocation, tool: 'type' },
    args: { ref: 'e1', text: 'must not be inserted' },
    admitPage: async () => null,
    state: () => ({ book: { byRef: new Map([['e1', 1]]) } }) as ReturnType<Call['state']>,
  })
  assert.equal(result.success, false)
  assert.equal(receipt(result).dispatch, 'notDispatched')
  assert.equal(f.sent(), 0)
  assert.match(JSON.stringify(result), /could not receive focus/)
})
