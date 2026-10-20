// 读页面：snapshot、screenshot、console、evaluate、wait。
import { BROWSER_SCREENSHOT_MAX_EDGE } from '../../../../packages/protocol/src/client-tools-browser.mjs'
import { BadArgs, bool, num, oneOf, str, timeout } from './args.mjs'
import { type AxNode, capLines, diffLines, formatAxTree } from './ax.mjs'
import type { Tool } from './executor.mjs'
import type { BrowserPage } from './model.mjs'
import { blockedByDialog, guarded, imageSize, pageLine, sleep, within } from './page-ops.mjs'
import {
  COLLECT_PASSWORDS,
  fieldNodes,
  isPasswordNode,
  maskAxNodes,
  redactSecrets,
} from './passwords/mask.mjs'

interface FrameTree {
  frame: { id: string; url: string; name?: string }
  childFrames?: FrameTree[]
}

/** 读、点之前的两道关：页面的来源要审批过，页面不能被对话框挡着 */
async function ready(call: Parameters<Tool>[0], page: BrowserPage) {
  const refusal = await call.admitPage(page)
  if (refusal) return { refusal }
  const blocked = blockedByDialog(page)
  if (blocked) return { refusal: call.done(page, blocked) }
  return null
}

/**
 * 一个框架的无障碍树，密码框的值遮住（passwords/mask.mts）。是不是密码框问 DOM；问不到的、又带着值的，
 * 也当密码框遮住
 */
async function maskedTree(page: BrowserPage, nodes: AxNode[]): Promise<AxNode[]> {
  const ids = fieldNodes(nodes)
  if (ids.length === 0) return nodes
  const valued = new Set(
    nodes
      .filter((node) => node.value?.value !== undefined && node.value.value !== '')
      .map((node) => node.backendDOMNodeId),
  )
  const secret = new Set<number>()
  await Promise.all(
    ids.map(async (backendNodeId) => {
      try {
        const { node } = await page.cdp<{ node: { nodeName?: string; attributes?: string[] } }>(
          'DOM.describeNode',
          { backendNodeId },
        )
        if (isPasswordNode(node)) secret.add(backendNodeId)
      } catch {
        if (valued.has(backendNodeId)) secret.add(backendNodeId)
      }
    }),
  )
  return maskAxNodes(nodes, secret)
}

/** 页面里密码框现在的值（主文档、同源子框架），evaluate 的结果里要替掉。取不到就是没有 */
async function passwordValues(page: BrowserPage): Promise<unknown[]> {
  try {
    const found = await page.cdp<{ result: { value?: unknown } }>('Runtime.evaluate', {
      expression: COLLECT_PASSWORDS,
      returnByValue: true,
      timeout: 2000,
    })
    return Array.isArray(found.result.value) ? found.result.value : []
  } catch {
    return []
  }
}

export const snapshot: Tool = async (call) => {
  const page = call.pick()
  const stop = await ready(call, page)
  if (stop) return stop.refusal
  const state = call.state(page)
  const { frameTree } = await page.cdp<{ frameTree: FrameTree }>('Page.getFrameTree')
  const lines = formatAxTree(
    await maskedTree(
      page,
      (await page.cdp<{ nodes: AxNode[] }>('Accessibility.getFullAXTree')).nodes,
    ),
    state.book,
  )
  // 子框架逐个取：同一个进程里的能取到；跨站的框架在别的进程里，取不到就说一声
  const walk = async (tree: FrameTree, depth: number) => {
    for (const child of tree.childFrames ?? []) {
      lines.push(`${'  '.repeat(depth)}- frame ${JSON.stringify(child.frame.url)}`)
      try {
        const { nodes } = await page.cdp<{ nodes: AxNode[] }>('Accessibility.getFullAXTree', {
          frameId: child.frame.id,
        })
        lines.push(...formatAxTree(await maskedTree(page, nodes), state.book, depth + 1))
      } catch {
        lines.push(
          `${'  '.repeat(depth + 1)}- (content of this cross-site frame is not available; use screenshot and x/y)`,
        )
      }
      await walk(child, depth + 1)
    }
  }
  await walk(frameTree, 0)
  const { lines: kept, cut } = capLines(lines)
  const before = state.lastSnapshot
  state.lastSnapshot = kept
  const head = pageLine(page)
  const tail = cut
    ? '\n(The page is longer; this snapshot was cut. Scroll and snapshot again.)'
    : ''
  if (bool(call.args, 'diff') === true && before) {
    const changes = diffLines(before, kept)
    if (changes) {
      return call.done(
        page,
        `${head}\n${changes.length === 0 ? '(no changes since the previous snapshot)' : changes.join('\n')}${tail}`,
      )
    }
  }
  return call.done(page, `${head}\n${kept.join('\n')}${tail}`)
}

interface Metrics {
  cssVisualViewport: { pageX: number; pageY: number; clientWidth: number; clientHeight: number }
}

export const screenshot: Tool = async (call) => {
  const page = call.pick()
  const stop = await ready(call, page)
  if (stop) return stop.refusal
  const format = oneOf(call.args, 'format', ['jpeg', 'png'] as const) ?? 'jpeg'
  const { cssVisualViewport: view } = await page.cdp<Metrics>('Page.getLayoutMetrics')
  const ratio = (
    await page.cdp<{ result: { value?: unknown } }>('Runtime.evaluate', {
      expression: 'devicePixelRatio',
      returnByValue: true,
    })
  ).result.value
  const dpr = typeof ratio === 'number' && ratio > 0 ? ratio : 1
  // 截出来的图在 CSS 像素上再按 fit 缩，最长边不超过上限；CDP 的 scale 还会乘上设备像素比，这里除掉
  const fit = Math.min(
    1,
    BROWSER_SCREENSHOT_MAX_EDGE / Math.max(view.clientWidth, view.clientHeight, 1),
  )
  const shot = await page.cdp<{ data: string }>('Page.captureScreenshot', {
    format,
    ...(format === 'jpeg' ? { quality: 70 } : {}),
    clip: {
      x: view.pageX,
      y: view.pageY,
      width: view.clientWidth,
      height: view.clientHeight,
      scale: fit / dpr,
    },
  })
  const size = imageSize(Buffer.from(shot.data, 'base64'))
  const width = size?.width ?? Math.round(view.clientWidth * fit)
  const height = size?.height ?? Math.round(view.clientHeight * fit)
  call.state(page).shotScale = width / Math.max(view.clientWidth, 1)
  return call.done(page, `${pageLine(page)}\nScreenshot ${width}x${height} pixels.`, [
    `data:image/${format};base64,${shot.data}`,
  ])
}

export const consoleTool: Tool = async (call) => {
  const page = call.pick()
  const refusal = await call.admitPage(page)
  if (refusal) return refusal
  const level = oneOf(call.args, 'level', ['all', 'error', 'warning'] as const) ?? 'all'
  const limit = Math.min(Math.max(Math.round(num(call.args, 'limit') ?? 50), 1), 200)
  const entries = page
    .consoleEntries()
    .filter((entry) =>
      level === 'all'
        ? true
        : level === 'error'
          ? entry.level === 'error'
          : entry.level === 'error' || entry.level === 'warning',
    )
    .slice(-limit)
  if (bool(call.args, 'clear') === true) page.clearConsole()
  const text =
    entries.length === 0
      ? 'No console messages.'
      : entries
          .map(
            (entry) => `[${entry.level}] ${entry.text}${entry.source ? ` (${entry.source})` : ''}`,
          )
          .join('\n')
  return call.done(page, `${pageLine(page)}\n${text}`)
}

interface EvalReply {
  result: { value?: unknown; type: string; description?: string }
  exceptionDetails?: { text?: string; exception?: { description?: string } }
}

/** evaluate 回的字最多这么长 */
const EVAL_MAX = 20_000

export const evaluate: Tool = async (call) => {
  const page = call.pick()
  const stop = await ready(call, page)
  if (stop) return stop.refusal
  const expression = str(call.args, 'expression', true)
  // 跑之前、跑之后各收一次密码框的值：脚本可能先读出来再把框清空
  const before = await passwordValues(page)
  const raced = await guarded(
    page,
    within(
      page.cdp<EvalReply>('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true,
        userGesture: true,
        timeout: 30_000,
      }),
      31_000,
      'the expression did not finish in 30 seconds',
    ),
  )
  if ('dialog' in raced) return call.done(page, 'The expression opened a dialog.')
  const reply = raced.value
  const secrets = [...before, ...(await passwordValues(page))]
  if (reply.exceptionDetails) {
    const detail =
      reply.exceptionDetails.exception?.description ?? reply.exceptionDetails.text ?? 'error'
    return call.done(page, `The expression threw: ${redactSecrets(detail, secrets)}`)
  }
  const raw =
    reply.result.type === 'undefined'
      ? 'undefined'
      : (JSON.stringify(reply.result.value) ?? String(reply.result.description))
  // 密码框的值不交给模型
  const value = redactSecrets(raw, secrets)
  const text =
    value.length > EVAL_MAX
      ? `${value.slice(0, EVAL_MAX)}… (cut, ${value.length} characters)`
      : value
  return call.done(page, text)
}

export const wait: Tool = async (call) => {
  const page = call.pick()
  const kind = oneOf(call.args, 'for', ['load', 'selector', 'text', 'time'] as const, true)
  const signal = call.context.signal
  if (kind === 'time') {
    await sleep(timeout(call.args, 'ms', 1000, 30_000), signal)
    return call.done(page, `Waited.\n${pageLine(page)}`)
  }
  const limit = timeout(call.args, 'timeoutMs', 10_000, 30_000)
  if (kind === 'load') {
    const ok = await page.waitForLoad(limit, signal)
    return call.done(
      page,
      `${ok ? 'Loaded.' : `Still loading after ${limit} ms.`}\n${pageLine(page)}`,
    )
  }
  const refusal = await call.admitPage(page)
  if (refusal) return refusal
  const needle = str(call.args, kind === 'selector' ? 'selector' : 'text')
  if (!needle) throw new BadArgs(`\`${kind}\` is required for for:"${kind}"`)
  const expression =
    kind === 'selector'
      ? `!!document.querySelector(${JSON.stringify(needle)})`
      : `!!(document.body && document.body.innerText.includes(${JSON.stringify(needle)}))`
  const until = Date.now() + limit
  for (;;) {
    if (page.dialog()) return call.done(page, 'Stopped waiting: a dialog opened.')
    try {
      const found = await page.cdp<{ result: { value?: unknown } }>('Runtime.evaluate', {
        expression,
        returnByValue: true,
      })
      if (found.result.value === true) return call.done(page, `Found.\n${pageLine(page)}`)
    } catch {
      // 页面正在换（跳转中），下一轮再看
    }
    if (Date.now() >= until)
      return call.done(page, `Not found after ${limit} ms.\n${pageLine(page)}`)
    await sleep(200, signal)
  }
}
