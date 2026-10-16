// 动页面：click、type、press、scroll、upload、dialog。
import { isAbsolute } from 'node:path'
import { clientToolFailure } from '../../../../packages/protocol/src/client-tools.mjs'
import { BadArgs, bool, num, oneOf, str, strings, target } from './args.mjs'
import type { Call, Tool } from './executor.mjs'
import { parseKey } from './keys.mjs'
import type { BrowserPage } from './model.mjs'
import {
  blockedByDialog,
  guarded,
  inputReady,
  nodeOf,
  pageLine,
  pointOf,
  settle,
} from './page-ops.mjs'

/** 上传的文件一个最大多少 */
const UPLOAD_MAX_BYTES = 100 * 1024 * 1024

async function ready(call: Call, page: BrowserPage) {
  const refusal = await call.admitPage(page)
  if (refusal) return refusal
  const blocked = blockedByDialog(page)
  return blocked ? call.done(page, blocked) : null
}

/** 动完之后的那句话：页面跳了就写新地址，开了对话框由 done 带上 */
async function after(call: Call, page: BrowserPage, what: string, dialog: boolean) {
  if (!dialog) await settle(page, call.context.signal)
  return call.done(page, `${what}\n${pageLine(page)}`)
}

export const click: Tool = async (call) => {
  const page = call.pick()
  const stop = await ready(call, page)
  if (stop) return stop
  const aim = target(call.args)
  const button = oneOf(call.args, 'button', ['left', 'right', 'middle'] as const) ?? 'left'
  const double = bool(call.args, 'double') === true
  if (!aim) throw new BadArgs('give `ref` or `x` and `y`')
  const point = await pointOf(call, page, aim)
  await inputReady(page)
  await page.pointAt(point.x, point.y, point.box.width, point.box.height)
  const mouse = (type: string, clickCount: number) =>
    page.cdp('Input.dispatchMouseEvent', { type, x: point.x, y: point.y, button, clickCount })
  const raced = await guarded(
    page,
    (async () => {
      await page.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y })
      await mouse('mousePressed', 1)
      await mouse('mouseReleased', 1)
      if (double) {
        await mouse('mousePressed', 2)
        await mouse('mouseReleased', 2)
      }
    })(),
  )
  const what = 'ref' in aim ? `Clicked ${aim.ref}.` : `Clicked at ${aim.x},${aim.y}.`
  return after(call, page, what, 'dialog' in raced)
}

/** 在元素上调的函数：下拉框按字选项；别的聚焦，要清空就全选（接着插入的字会替掉它） */
const PREPARE = `function (text, clear) {
  if (this.tagName === 'SELECT') {
    const option = Array.from(this.options).find((one) => one.label === text || one.value === text || one.text.trim() === text)
    if (!option) return { kind: 'select', ok: false, options: Array.from(this.options).map((one) => one.label).slice(0, 50) }
    this.value = option.value
    this.dispatchEvent(new Event('input', { bubbles: true }))
    this.dispatchEvent(new Event('change', { bubbles: true }))
    return { kind: 'select', ok: true, label: option.label }
  }
  this.focus()
  if (clear) {
    if (typeof this.select === 'function') this.select()
    else if (this.isContentEditable) document.getSelection().selectAllChildren(this)
  }
  return { kind: 'field', ok: document.activeElement === this || this.contains(document.activeElement) }
}`

const READ_VALUE = `function () { return 'value' in this ? String(this.value) : (this.innerText || '') }`

export const type: Tool = async (call) => {
  const page = call.pick()
  const stop = await ready(call, page)
  if (stop) return stop
  const text = str(call.args, 'text', true)
  const clear = bool(call.args, 'clear') === true
  const submit = bool(call.args, 'submit') === true
  const ref = str(call.args, 'ref')
  let objectId: string | null = null
  try {
    if (ref !== undefined) {
      const backendNodeId = nodeOf(call, page, ref)
      try {
        await page.cdp('DOM.scrollIntoViewIfNeeded', { backendNodeId })
      } catch {
        // 滚不了也接着试
      }
      const resolved = await page.cdp<{ object: { objectId?: string } }>('DOM.resolveNode', {
        backendNodeId,
      })
      objectId = resolved.object.objectId ?? null
      if (!objectId) throw new BadArgs(`element ${ref} is gone; take a new \`snapshot\``)
      const prepared = (
        await page.cdp<{
          result: { value?: { kind: string; ok: boolean; label?: string; options?: string[] } }
        }>('Runtime.callFunctionOn', {
          objectId,
          functionDeclaration: PREPARE,
          arguments: [{ value: text }, { value: clear }],
          returnByValue: true,
        })
      ).result.value
      if (prepared?.kind === 'select') {
        if (!prepared.ok) {
          return call.done(
            page,
            `No option ${JSON.stringify(text)} in ${ref}. Options: ${JSON.stringify(prepared.options ?? [])}`,
          )
        }
        return after(call, page, `Selected ${JSON.stringify(prepared.label)} in ${ref}.`, false)
      }
    }
    await inputReady(page)
    const raced = await guarded(
      page,
      (async () => {
        if (text !== '') await page.cdp('Input.insertText', { text })
        if (submit) {
          const enter = parseKey('Enter')
          if (enter) {
            await page.cdp('Input.dispatchKeyEvent', enter.down)
            await page.cdp('Input.dispatchKeyEvent', enter.up)
          }
        }
      })(),
    )
    let now = ''
    if (objectId && !('dialog' in raced) && !submit) {
      const value = await page.cdp<{ result: { value?: unknown } }>('Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: READ_VALUE,
        returnByValue: true,
      })
      if (typeof value.result.value === 'string')
        now = ` Its value is now ${JSON.stringify(value.result.value.slice(0, 500))}.`
    }
    const where = ref ? ` into ${ref}` : ' into the focused element'
    return after(
      call,
      page,
      `Typed${where}${submit ? ' and pressed Enter' : ''}.${now}`,
      'dialog' in raced,
    )
  } finally {
    if (objectId) void page.cdp('Runtime.releaseObject', { objectId }).catch(() => {})
  }
}

export const press: Tool = async (call) => {
  const page = call.pick()
  const stop = await ready(call, page)
  if (stop) return stop
  const combo = str(call.args, 'key', true)
  const key = parseKey(combo)
  if (!key)
    throw new BadArgs(
      `unknown key ${JSON.stringify(combo)}; use names like Enter, Tab, Escape, ArrowDown, Control+A`,
    )
  await inputReady(page)
  const raced = await guarded(
    page,
    (async () => {
      await page.cdp('Input.dispatchKeyEvent', key.down)
      await page.cdp('Input.dispatchKeyEvent', key.up)
    })(),
  )
  return after(call, page, `Pressed ${combo}.`, 'dialog' in raced)
}

export const scroll: Tool = async (call) => {
  const page = call.pick()
  const stop = await ready(call, page)
  if (stop) return stop
  const aim = target(call.args, true)
  const dx = num(call.args, 'dx') ?? 0
  const dyGiven = num(call.args, 'dy')
  if (aim && 'ref' in aim && dx === 0 && dyGiven === undefined) {
    await page.cdp('DOM.scrollIntoViewIfNeeded', { backendNodeId: nodeOf(call, page, aim.ref) })
    return call.done(page, `Scrolled ${aim.ref} into view.`)
  }
  const metrics = await page.cdp<{
    cssVisualViewport: { clientWidth: number; clientHeight: number }
  }>('Page.getLayoutMetrics')
  const view = metrics.cssVisualViewport
  const point = aim
    ? await pointOf(call, page, aim)
    : { x: view.clientWidth / 2, y: view.clientHeight / 2 }
  const dy = dyGiven ?? (dx === 0 ? Math.round(view.clientHeight * 0.8) : 0)
  await inputReady(page)
  await page.cdp('Input.dispatchMouseEvent', {
    type: 'mouseWheel',
    x: point.x,
    y: point.y,
    deltaX: dx,
    deltaY: dy,
  })
  await new Promise((resolve) => setTimeout(resolve, 150))
  const position = await page.cdp<{ result: { value?: unknown } }>('Runtime.evaluate', {
    expression:
      '[Math.round(scrollX), Math.round(scrollY), Math.round(document.documentElement.scrollHeight)]',
    returnByValue: true,
  })
  const [x, y, height] = Array.isArray(position.result.value) ? position.result.value : []
  return call.done(
    page,
    `Scrolled by ${dx},${dy}. Page scroll is now ${x},${y} of height ${height}.`,
  )
}

export const upload: Tool = async (call) => {
  if (call.invocation.device.kind !== 'local') {
    return clientToolFailure(
      'invalid',
      'upload is only available when the conversation runs on the same computer as the Litch desktop app; files of a remote device cannot be uploaded from here.',
    )
  }
  const page = call.pick()
  const stop = await ready(call, page)
  if (stop) return stop
  const ref = str(call.args, 'ref', true)
  const paths = strings(call.args, 'paths')
  for (const path of paths) {
    if (!isAbsolute(path)) throw new BadArgs(`not an absolute path: ${path}`)
    const stat = call.statFile(path)
    if (!stat?.file) throw new BadArgs(`not a file: ${path}`)
    if (stat.size > UPLOAD_MAX_BYTES) throw new BadArgs(`file is larger than 100 MB: ${path}`)
  }
  const backendNodeId = nodeOf(call, page, ref)
  const described = await page.cdp<{ node: { nodeName?: string; attributes?: string[] } }>(
    'DOM.describeNode',
    {
      backendNodeId,
    },
  )
  const attributes = described.node.attributes ?? []
  const typeAt = attributes.findIndex(
    (one, index) => index % 2 === 0 && one.toLowerCase() === 'type',
  )
  const isFile =
    described.node.nodeName?.toUpperCase() === 'INPUT' &&
    attributes[typeAt + 1]?.toLowerCase() === 'file'
  if (!isFile) throw new BadArgs(`${ref} is not an <input type="file">`)
  await page.cdp('DOM.setFileInputFiles', { files: paths, backendNodeId })
  return call.done(page, `Set ${paths.length} file(s) on ${ref}.`)
}

export const dialog: Tool = async (call) => {
  const page = call.pick()
  const open = page.dialog()
  if (!open) return call.done(page, 'No dialog is open.')
  const accept = bool(call.args, 'accept')
  if (accept === undefined) throw new BadArgs('`accept` is required')
  const text = str(call.args, 'text')
  await page.cdp('Page.handleJavaScriptDialog', {
    accept,
    ...(text !== undefined ? { promptText: text } : {}),
  })
  return after(call, page, `${accept ? 'Accepted' : 'Dismissed'} the ${open.type} dialog.`, false)
}
