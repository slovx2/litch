// 几个工具共用的页面操作：按编号或坐标找到点哪里、动手时别卡在对话框上、动完等页面稳一下、量图片大小。
import { BadArgs, type Target } from './args.mjs'
import type { Call } from './executor.mjs'
import type { BrowserPage, DialogInfo } from './model.mjs'

/** 等一会儿；signal 中止时提前结束并抛错 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('cancelled'))
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new Error('cancelled'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** 给一件事定个时限：到点没完就当它失败（原来那件事的结果之后来了也不管） */
export function within<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms)
  })
  return Promise.race([work, late]).finally(() => clearTimeout(timer))
}

/**
 * 做一件可能弹出对话框的事（点击、按键、跑脚本）。对话框一开，页面就停住了，
 * 这件事本身的应答要等对话框关了才回来，所以和“对话框开了”赛跑：先开了就回 dialog
 */
export async function guarded<T>(
  page: BrowserPage,
  work: Promise<T>,
): Promise<{ value: T } | { dialog: DialogInfo }> {
  const open = page.dialog()
  if (open) {
    // 先别让 work 的拒绝变成未处理的
    work.catch(() => {})
    return { dialog: open }
  }
  const raced = await Promise.race([
    work.then((value) => ({ value })),
    page.dialogOpened().then((dialog) => ({ dialog })),
  ])
  if ('dialog' in raced) work.catch(() => {})
  return raced
}

/** 页面响应与绘制是两件事：后台可停帧，不能据此拒绝输入。 */
export async function inputReady(page: BrowserPage): Promise<void> {
  // 每次输入都确认模拟焦点；导航或交还登录控制后也不依赖认领时的状态。
  await within(
    page.cdp('Emulation.setFocusEmulationEnabled', { enabled: true }),
    1200,
    'The browser did not confirm input focus. Take a fresh snapshot and check the browser connection; bringing Chrome to the foreground is not required.',
  )
  const probe = async () => {
    const reply = await within(
      page.cdp<{ result?: { value?: number }; exceptionDetails?: unknown }>('Runtime.evaluate', {
        expression:
          'document.documentElement && document.documentElement.getBoundingClientRect().width > 0 ? performance.timeOrigin : null',
        returnByValue: true,
        timeout: 1000,
      }),
      1200,
      'The page is not responding to input preparation. Wait for it to load, then take a fresh snapshot; if it remains unresponsive, reload it. Bringing Chrome to the foreground is not required.',
    )
    if (reply.exceptionDetails || typeof reply.result?.value !== 'number')
      throw new BadArgs(
        'The page has no usable document yet. Wait for load and take a fresh snapshot before input.',
      )
    return reply.result.value
  }
  const before = await probe()
  // 首次绘制能减少刚加载页面丢输入的概率，但只作短暂优化。上限由宿主计时，
  // 不依赖同样可能被节流的页面 setTimeout；迟到的回调只观察，不会派发输入。
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      page.cdp('Runtime.evaluate', {
        expression: `new Promise((done) => {
          let frame;
          const finish = () => { cancelAnimationFrame(frame); clearTimeout(timer); done(true); };
          const timer = setTimeout(finish, 160);
          frame = requestAnimationFrame(() => { frame = requestAnimationFrame(finish); });
        })`,
        awaitPromise: true,
      }),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 200)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
  // 超时仅降级绘制等待；新的同步探测仍经来源/租约/文档闸，真正卡死不能放行。
  if (before !== (await probe()))
    throw new BadArgs('The document changed while preparing input. Take a fresh snapshot.')
}

/** 页面开着对话框时先让模型答它：除了 dialog 工具，别的都动不了页面 */
export function blockedByDialog(page: BrowserPage): string | null {
  const open = page.dialog()
  return open
    ? `A ${open.type} dialog is open and blocks the page: ${JSON.stringify(open.message)}. Answer it with \`dialog\` first.`
    : null
}

interface Quad {
  quads?: number[][]
}

/** 编号对应的 DOM 节点（backendNodeId）。编号不认识时抛错 */
export function nodeOf(call: Call, page: BrowserPage, ref: string): number {
  const node = call.state(page).book.byRef.get(ref)
  if (node === undefined) {
    throw Object.assign(
      new BadArgs(
        `stale or unknown ref ${ref}; current generation is ${call.state(page).book.generation}. Take a new snapshot and use its refs (refs belong to one tab/document).`,
      ),
      { code: 'staleRef' },
    )
  }
  return node
}

/** 元素中心在视口里的位置（CSS 像素）。先滚到看得见 */
export async function centerOf(page: BrowserPage, backendNodeId: number) {
  try {
    await page.cdp('DOM.scrollIntoViewIfNeeded', { backendNodeId })
  } catch {
    // 有的节点（比如 option）滚不了，接着量
  }
  let quads: number[][] = []
  try {
    quads = (await page.cdp<Quad>('DOM.getContentQuads', { backendNodeId })).quads ?? []
  } catch {
    throw new BadArgs('the element is gone; take a new `snapshot`')
  }
  const quad = quads.find((one) => one.length === 8)
  if (!quad) throw new BadArgs('the element has no visible box; scroll or take a new `snapshot`')
  const xs = [quad[0], quad[2], quad[4], quad[6]].map(Number)
  const ys = [quad[1], quad[3], quad[5], quad[7]].map(Number)
  const left = Math.min(...xs)
  const top = Math.min(...ys)
  const width = Math.max(...xs) - left
  const height = Math.max(...ys) - top
  return { x: left + width / 2, y: top + height / 2, box: { left, top, width, height } }
}

/** 目标在视口里的位置（CSS 像素）：编号就量元素，坐标就从截图像素换回来 */
export async function pointOf(call: Call, page: BrowserPage, target: Target) {
  if ('ref' in target) return centerOf(page, nodeOf(call, page, target.ref))
  const scale = call.state(page).shotScale
  const x = target.x / scale
  const y = target.y / scale
  return { x, y, box: { left: x - 6, top: y - 6, width: 12, height: 12 } }
}

/** 动手之后：等一小会儿看页面是不是开始跳转了，跳了就等它加载完 */
export async function settle(page: BrowserPage, signal: AbortSignal): Promise<void> {
  await sleep(250, signal)
  if (page.info().loading && !page.dialog()) await page.waitForLoad(10_000, signal)
}

/** 页面的一行说明：标题和地址 */
export function pageLine(page: BrowserPage): string {
  const info = page.info()
  return `Tab ${info.id}: ${JSON.stringify(info.title)} ${info.url}${info.loading ? ' (loading)' : ''}`
}

/** PNG、JPEG 的宽高，从文件头里读；认不出是 null */
export function imageSize(bytes: Uint8Array): { width: number; height: number } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (bytes.length > 24 && bytes[0] === 0x89 && bytes[1] === 0x50) {
    return { width: view.getUint32(16), height: view.getUint32(20) }
  }
  if (bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let at = 2
    while (at + 9 < bytes.length) {
      if (bytes[at] !== 0xff) return null
      const marker = bytes[at + 1] ?? 0
      const length = view.getUint16(at + 2)
      // SOF0 到 SOF15，除了 DHT(C4)、JPG(C8)、DAC(CC)
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { height: view.getUint16(at + 5), width: view.getUint16(at + 7) }
      }
      at += 2 + length
    }
  }
  return null
}
