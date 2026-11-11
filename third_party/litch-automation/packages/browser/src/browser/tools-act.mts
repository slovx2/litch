// 动页面：click、type、press、scroll、upload、dialog。
import { isAbsolute } from 'node:path'
import { clientToolFailure } from '../tool-port.mjs'
import { BadArgs, bool, num, oneOf, str, strings, target } from './args.mjs'
import type { Call, Tool } from './executor.mjs'
import { INPUT_PREPARE_MARK } from './input-command.mjs'
import { observedInput } from './input-receipt.mjs'
import { parseKey } from './keys.mjs'
import type { BrowserPage } from './model.mjs'
import { blockedByDialog, guarded, inputReady, nodeOf, pageLine, pointOf } from './page-ops.mjs'
import { uploadBufferedFiles } from './upload-files.mjs'
import { associatedInput, fileInput, validateFiles } from './upload-target.mjs'

/** 上传的文件一个最大多少 */
const UPLOAD_MAX_BYTES = 100 * 1024 * 1024

async function ready(call: Call, page: BrowserPage) {
  const refusal = await call.admitPage(page)
  if (refusal) return refusal
  const blocked = blockedByDialog(page)
  return blocked ? clientToolFailure('failed', blocked) : null
}

/** 动完之后的那句话：页面跳了就写新地址，开了对话框由 done 带上 */
function after(call: Call, page: BrowserPage, what: string, _dialog: boolean) {
  return call.done(page, `${what}\n${pageLine(page)}`)
}

const clickAction: Tool = async (call) => {
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
  ${INPUT_PREPARE_MARK}
  if (this.tagName === 'SELECT') {
    const option = Array.from(this.options).find((one) => one.label === text || one.value === text || one.text.trim() === text)
    if (!option) return { kind: 'select', ok: false, options: Array.from(this.options).map((one) => one.label).slice(0, 50) }
    this.focus()
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

const typeAction: Tool = async (call) => {
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
      if (!prepared?.ok && prepared?.kind !== 'select')
        throw new BadArgs(
          'The field could not receive focus; no text was inserted. Take a fresh snapshot.',
        )
      if (prepared?.kind === 'select') {
        if (!prepared.ok) {
          return clientToolFailure(
            'failed',
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
    const where = ref ? ` into ${ref}` : ' into the focused element'
    return after(
      call,
      page,
      `Typed${where}${submit ? ' and pressed Enter' : ''}.`,
      'dialog' in raced,
    )
  } finally {
    if (objectId) void page.cdp('Runtime.releaseObject', { objectId }).catch(() => {})
  }
}

const pressAction: Tool = async (call) => {
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

const scrollAction: Tool = async (call) => {
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

const uploadAction: Tool = async (call) => {
  if (call.invocation.device.kind !== 'local' && !call.context.prepareUpload)
    return clientToolFailure(
      'invalid',
      'The host cannot read upload files from this session device. Update the device service and desktop app. Remote paths are never read on the controlling desktop.',
    )
  const page = call.pick()
  const stop = await ready(call, page)
  if (stop) return stop
  const ref = str(call.args, 'ref', true)
  let paths = strings(call.args, 'paths')
  const mode = oneOf(call.args, 'mode', ['input', 'drop'] as const) ?? 'input'
  if (mode === 'drop' && !call.uploadFiles)
    throw new BadArgs(
      'Drop upload is only supported in Chrome. Use a file input or upload trigger ref.',
    )
  if (paths.length > 32) throw new BadArgs('Upload accepts 1 to 32 files per call.')
  const limit = call.uploadMaxBytes ?? UPLOAD_MAX_BYTES
  const prepared =
    call.invocation.device.kind !== 'local'
      ? await call.context.prepareUpload!(paths, {
          fileBytes: limit,
          totalBytes: call.uploadFiles ? limit : limit * 32,
        })
      : null
  if (prepared) paths = prepared.paths
  // 远程临时文件必须在返回时删除。先构造独立于磁盘路径的 File，网页稍后提交仍可读取。
  const uploadFiles =
    call.uploadFiles ??
    (prepared
      ? (
          page: Parameters<typeof uploadBufferedFiles>[0],
          node: number,
          files: string[],
          mode: 'input' | 'drop',
        ) =>
          uploadBufferedFiles(
            page,
            node,
            files,
            mode,
            { fileBytes: limit, totalBytes: limit * 32 },
            call.context.signal,
          )
      : undefined)
  try {
    call.context.signal.throwIfAborted()
    for (const path of paths) {
      if (!isAbsolute(path)) throw new BadArgs(`not an absolute path: ${path}`)
      const stat = call.statFile(path)
      if (!stat?.file) throw new BadArgs(`not a file: ${path}`)
      if (stat.size > limit)
        throw new BadArgs(
          `file is larger than ${limit / 1024 / 1024} MiB: ${path}. This environment cannot upload files above that limit; do not start a local file server.`,
        )
    }
    let backendNodeId = nodeOf(call, page, ref)
    let attrs = await fileInput(page, backendNodeId)
    if (mode === 'input' && !attrs) {
      if (!page.interceptFileChooser)
        throw new BadArgs(
          'This environment does not support file chooser interception. Use a file input ref from snapshot.',
        )
      const interception = await page.interceptFileChooser(call.context.signal)
      try {
        const clicked = await clickAction({ ...call, args: { ref } })
        if (!clicked.success) return clicked
        const chooser = await interception.wait(1500)
        if (chooser && chooser.mode !== 'selectMultiple' && paths.length > 1)
          throw new BadArgs('This file chooser accepts only one file.')
        if (chooser) {
          if (chooser.backendNodeId === undefined)
            throw new BadArgs(
              'This environment does not support this file chooser: it has no file input node.',
            )
          backendNodeId = chooser.backendNodeId
        } else backendNodeId = await associatedInput(page, backendNodeId)
        attrs = await fileInput(page, backendNodeId)
        if (!attrs)
          throw new BadArgs(
            'The file chooser did not identify a file input; this environment does not support this chooser.',
          )
        validateFiles(attrs, paths)
        if (uploadFiles) await uploadFiles(page, backendNodeId, paths, mode)
        else await page.cdp('DOM.setFileInputFiles', { files: paths, backendNodeId })
      } finally {
        await interception.dispose()
      }
    } else {
      if (attrs && mode === 'input') validateFiles(attrs, paths)
      if (uploadFiles) await uploadFiles(page, backendNodeId, paths, mode)
      else await page.cdp('DOM.setFileInputFiles', { files: paths, backendNodeId })
    }
    return call.done(
      page,
      `${mode === 'drop' ? 'Dispatched a drop with' : 'Set'} ${paths.length} file(s) on ${ref}.` +
        (uploadFiles
          ? ' The browser used synthetic events. Verify the page accepted the files using its file name, progress or success message. Do not start a local file server or change extension permissions.'
          : ''),
    )
  } finally {
    await prepared?.dispose()
  }
}

const dialogAction: Tool = async (call) => {
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

export const click = observedInput(clickAction)
export const type = observedInput(typeAction)
export const press = observedInput(pressAction)
export const scroll = observedInput(scrollAction)
const observedUpload = observedInput(uploadAction)
export const upload: Tool = (call) =>
  call.invocation.device.kind === 'local' || call.context.prepareUpload
    ? observedUpload(call)
    : uploadAction(call)
export const dialog = observedInput(dialogAction)
