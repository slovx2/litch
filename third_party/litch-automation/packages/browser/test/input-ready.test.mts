import assert from 'node:assert/strict'
import test from 'node:test'
import type { BrowserPage } from '../src/browser/model.mjs'
import { inputReady } from '../src/browser/page-ops.mjs'

function page(send: (method: string, params: Record<string, unknown>) => Promise<unknown>) {
  return { cdp: send } as BrowserPage
}

test('不绘制但脚本和布局可响应：宿主短等后放行，并在每次准备时确认焦点', async () => {
  const commands: string[] = []
  let probes = 0
  const target = page(async (method, params) => {
    commands.push(method)
    if (params.awaitPromise) return new Promise(() => {})
    if (method === 'Runtime.evaluate') probes++
    return { result: { value: 123 } }
  })
  await inputReady(target)
  await inputReady(target)
  assert.equal(probes, 4)
  assert.equal(commands.filter((m) => m === 'Emulation.setFocusEmulationEnabled').length, 2)
  assert.equal(
    commands.some((m) => m.startsWith('Input.')),
    false,
  )
})

test('绘制期间导航不能用旧目标继续输入', async () => {
  let document = 1
  await assert.rejects(
    inputReady(
      page(async (_method, params) => {
        if (params.awaitPromise) document++
        return { result: { value: document } }
      }),
    ),
    /document changed/,
  )
})

test('绘制降级后同步探测仍传播来源、租约、暂停和 CDP 拒绝', async () => {
  for (const reason of ['originNotApproved', 'staleLease', 'signingIn', 'staleDocument']) {
    let probes = 0
    await assert.rejects(
      inputReady(
        page(async (method, params) => {
          if (params.awaitPromise) return new Promise(() => {})
          if (method === 'Runtime.evaluate' && ++probes > 1) throw Error(reason)
          return { result: { value: 1 } }
        }),
      ),
      new RegExp(reason),
    )
  }
})

test('同步脚本异常与尚无文档不会被当作停帧放行', async () => {
  for (const reply of [{ exceptionDetails: {} }, { result: { value: null } }])
    await assert.rejects(inputReady(page(async () => reply)), /no usable document/)
})

test('真正无响应的文档明确报错，不能靠绘制降级放行', async () => {
  await assert.rejects(
    inputReady(
      page(async (method) => {
        if (method === 'Runtime.evaluate') return new Promise(() => {})
        return {}
      }),
    ),
    /page is not responding.*fresh snapshot.*foreground is not required/,
  )
})
