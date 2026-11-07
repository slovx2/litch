// 真实回环下载与真实面板审批；所有文件在验收私有 profile 中，绝不使用系统真实下载目录。
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, symlinkSync, unlinkSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { app, shell } from 'electron'
import type { ClientToolCallResponse } from '../../../packages/protocol/src/client-tools.mjs'
import type { HostTab } from './browser/electron-tab.mjs'
import type { InstalledBrowser } from './browser/install.mjs'
import type { ClientToolAsk, ClientToolInvocation } from './client-tools/types.mjs'

function required<T>(value: T | null | undefined): T {
  assert.ok(value !== null && value !== undefined)
  return value
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const textOf = (reply: ClientToolCallResponse) =>
  reply.contentItems.map((part) => (part.type === 'inputText' ? part.text : '')).join('\n')
export async function checkDownloads(options: {
  browser: InstalledBrowser
  tabId: string
  page(code: string): Promise<unknown>
  until(code: string, ms?: number): Promise<boolean>
  check(name: string, ok: boolean, detail?: unknown): void
}): Promise<void> {
  const { browser, page, until, check } = options
  const host = browser.host
  const downloads = required(host.downloads)
  const user = host.page(options.tabId) as HostTab
  const owner = user.info().owner
  const counts = new Map<string, number>()
  const big = Buffer.alloc(16 * 1024 * 1024, 97)
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost')
    if (url.pathname === '/page') {
      response.setHeader('content-type', 'text/html')
      response.end(
        `<html><body><a style="display:block;padding:20px" href="/file?id=${url.searchParams.get('id')}">Download</a><input type="file" aria-label="File"></body></html>`,
      )
      return
    }
    const id = url.searchParams.get('id') ?? 'unknown'
    counts.set(id, (counts.get(id) ?? 0) + 1)
    if ((counts.get(id) ?? 0) > 1) {
      response.writeHead(410)
      response.end('one-time link consumed')
      return
    }
    response.setHeader('content-disposition', 'attachment; filename="one-time.p8"')
    response.setHeader('content-type', 'application/octet-stream')
    if (id === 'oversize') response.setHeader('content-length', String(1024 ** 3 + 1))
    else if (id !== 'unknown')
      response.setHeader('content-length', String(id === 'large' ? big.length : 6))
    else response.setHeader('transfer-encoding', 'chunked')
    if (id === 'large') {
      let offset = 0
      const timer = setInterval(() => {
        if (offset >= big.length) {
          clearInterval(timer)
          response.end()
          return
        }
        response.write(big.subarray(offset, offset + 256 * 1024))
        offset += 256 * 1024
      }, 8)
      response.on('close', () => clearInterval(timer))
    } else if (id === 'unknown') {
      response.flushHeaders()
      response.write(Buffer.alloc(4096, 120))
      const timer = setTimeout(() => response.end('end'), 5000)
      response.on('close', () => clearTimeout(timer))
    } else response.end('secret')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const awaitState = async (predicate: () => boolean) => {
    const end = Date.now() + 15_000
    while (Date.now() < end) {
      if (predicate()) return true
      await sleep(40)
    }
    return false
  }
  let seq = 0
  const asks: ClientToolAsk[] = []
  const context = {
    signal: new AbortController().signal,
    ask: async () => 'decline' as const,
    show: (ask: ClientToolAsk) => {
      asks.push(ask)
      return () => {}
    },
  }
  const call = (tool: string, args: Record<string, unknown> = {}) => {
    const invocation: ClientToolInvocation = {
      id: `download-${++seq}`,
      callId: `d${seq}`,
      threadId: owner.threadId,
      turnId: 'downloads',
      namespace: 'litch_browser',
      tool,
      arguments: args,
      device: { id: owner.deviceId, name: 'Local', kind: 'local', target: null },
      harness: 'pi',
      cwd: null,
    }
    return browser.executor.call(invocation, context)
  }
  const clickUser = async (id: string) => {
    await user.load(`${origin}/page?id=${id}`, 5000)
    user.view.webContents.setBackgroundThrottling(false)
    await sleep(150)
    const point = (await user.view.webContents.executeJavaScript(
      '(()=>{const r=document.querySelector("a").getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()',
    )) as { x: number; y: number }
    for (const type of ['mousePressed', 'mouseReleased'])
      await user.cdp('Input.dispatchMouseEvent', { ...point, type, button: 'left', clickCount: 1 })
  }
  const clickAgent = async (id: string, batch = false) => {
    await call('navigate', { url: `${origin}/page?id=${id}`, newTab: true })
    const current = required(browser.executor.currentTab(owner.deviceId, owner.threadId))
    const snapshot = await call('snapshot', { tabId: current })
    const ref = /link "Download".*?\[ref=(e\d+)\]/.exec(textOf(snapshot))?.[1]
    if (!ref) throw new Error(`下载链接不在快照里：${textOf(snapshot)}`)
    return {
      tabId: current,
      pending: batch
        ? call('run_actions', {
            actions: [
              { tool: 'click', arguments: { tabId: current, ref } },
              { tool: 'press', arguments: { tabId: current, key: 'Enter' } },
            ],
          })
        : call('click', { tabId: current, ref }),
    }
  }
  const row = (id: string) => `document.querySelector('[data-download="${id}"]')`
  const saved: string[] = []
  const originalReveal = shell.showItemInFolder
  let revealed = ''
  shell.showItemInFolder = (path) => {
    revealed = path
  }
  try {
    await clickUser('user')
    check(
      '下载：用户标签真实点击自动保存',
      await awaitState(() => downloads.list().at(-1)?.status === 'completed'),
    )
    const first = required(downloads.list().at(-1))
    saved.push(required(first.path))
    check(
      '下载：用户面板显示成功、最终路径及文件夹入口',
      await until(
        `${row(first.id)}?.dataset.status === 'completed' && ${row(first.id)}.textContent.includes(${JSON.stringify(first.path)}) && ${row(first.id)}.querySelector('[data-download-reveal]')`,
      ),
    )
    await page(`${row(first.id)}.querySelector('[data-download-reveal]').click()`)
    check('下载：文件夹入口仅打开管理器保存的文件', await awaitState(() => revealed === first.path))

    const allowed = await clickAgent('approved')
    check(
      '下载：代理请求出现面板审批',
      await until("document.querySelector('[data-status=pending] [data-download-allow]')"),
    )
    const second = required(downloads.list().at(-1))
    check(
      '下载：批准前不暴露路径，下载目录只有用户文件',
      !second.path && readdirSync(app.getPath('downloads')).length === 1,
    )
    check(
      '下载：审批卡包含文件名、真实来源与大小',
      await until(
        `${row(second.id)}.textContent.includes('one-time.p8') && ${row(second.id)}.textContent.includes(${JSON.stringify(origin)}) && ${row(second.id)}.textContent.includes('6 B')`,
      ),
    )
    check(
      '下载：同时走会话审批通道，真实元数据完整',
      await awaitState(() =>
        asks.some(
          (ask) =>
            ask.kind === 'browserDownload' &&
            ask.filename === 'one-time.p8' &&
            ask.origin === origin &&
            ask.totalBytes === 6,
        ),
      ),
    )
    const privateRoot = join(app.getPath('userData'), 'browser', 'download-staging')
    await awaitState(() =>
      readdirSync(privateRoot).some((name) => existsSync(join(privateRoot, name, 'payload'))),
    )
    const privateFile = join(privateRoot, readdirSync(privateRoot)[0] ?? '', 'payload')
    const alias = join(app.getPath('userData'), 'pending-alias')
    symlinkSync(privateFile, alias)
    const privateSnapshot = await call('snapshot', { tabId: allowed.tabId })
    const fileRef = /.*File.*?\[ref=(e\d+)\]/.exec(textOf(privateSnapshot))?.[1] ?? 'e999'
    for (const path of [privateFile, alias]) {
      const upload = await call('upload', { tabId: allowed.tabId, ref: fileRef, paths: [path] })
      check(
        '下载：浏览器上传拒绝私有文件和符号链接',
        !upload.success && textOf(upload).includes('not a file'),
        textOf(upload),
      )
    }
    unlinkSync(alias)
    const read = await call('evaluate', {
      tabId: allowed.tabId,
      expression: `fetch(${JSON.stringify(pathToFileURL(privateFile).href)}).then(()=>"read").catch(()=>"blocked")`,
    })
    check('下载：网页不能 fetch 私有文件', read.success && textOf(read).includes('blocked'))
    await page(`${row(second.id)}.querySelector('[data-download-allow]').click()`)
    await allowed.pending
    check(
      '下载：批准后保存',
      await awaitState(
        () => downloads.list().find((one) => one.id === second.id)?.status === 'completed',
      ),
    )
    const approved = required(downloads.list().find((one) => one.id === second.id))
    saved.push(required(approved.path))
    check(
      '下载：重名文件编号，原文件不被覆盖',
      approved.filename === 'one-time (1).p8' &&
        readFileSync(required(first.path), 'utf8') === 'secret',
    )
    const status = await call('downloads')
    check(
      '下载：Agent 拿到最终路径及控制端说明',
      textOf(status).includes(required(approved.path)) &&
        textOf(status).includes('controlling desktop'),
    )
    check(
      '下载：Agent 结果没有私有目录',
      !textOf(status).includes('download-staging') && !textOf(status).includes('transfer-'),
    )

    const denied = await clickAgent('declined', true)
    check(
      '下载：第二个代理文件仍逐个审批',
      await until("document.querySelector('[data-status=pending] [data-download-decline]')"),
    )
    const third = required(downloads.list().at(-1))
    await page(`${row(third.id)}.querySelector('[data-download-decline]').click()`)
    const deniedResult = await denied.pending
    check(
      '下载：拒绝使批量动作停止，后续 Enter 不会重放链接',
      !deniedResult.success && counts.get('declined') === 1,
    )
    check(
      '下载：拒绝后无最终文件，私有目录清空',
      await awaitState(
        () =>
          downloads.list().at(-1)?.status === 'declined' &&
          readdirSync(join(app.getPath('userData'), 'browser', 'download-staging')).length === 0,
      ),
    )
    check('下载：拒绝没有增加下载目录文件', readdirSync(app.getPath('downloads')).length === 2)

    const large = await clickAgent('large')
    check(
      '下载：大文件审批显示正确大小',
      await until(
        "document.querySelector('[data-status=pending]')?.textContent.includes('16.0 MiB')",
      ),
    )
    const fourth = required(downloads.list().at(-1))
    await page(`${row(fourth.id)}.querySelector('[data-download-allow]').click()`)
    await large.pending
    check(
      '下载：16 MiB 大文件完成',
      await awaitState(() => downloads.list().at(-1)?.status === 'completed'),
    )
    const bigFile = required(downloads.list().at(-1))
    saved.push(required(bigFile.path))
    check(
      '下载：大文件内容哈希相同',
      createHash('sha256')
        .update(readFileSync(required(bigFile.path)))
        .digest('hex') === createHash('sha256').update(big).digest('hex'),
    )

    const unknown = await clickAgent('unknown')
    check(
      '下载：未知长度显示未知，不伪造大小',
      await until(
        "document.querySelector('[data-status=pending]')?.textContent.includes('大小未知')",
      ),
      {
        download: downloads.list().at(-1),
        html: await page("document.querySelector('.bw-downloads')?.textContent"),
      },
    )
    const fifth = required(downloads.list().at(-1))
    await page(`${row(fifth.id)}.querySelector('[data-download-decline]').click()`)
    await unknown.pending
    await clickUser('oversize')
    check(
      '下载：超上限文件明确失败',
      await awaitState(() => downloads.list().at(-1)?.status === 'failed'),
    )
    check(
      '下载：每个一次性链接只请求一次',
      counts.size === 6 && [...counts.values()].every((n) => n === 1),
      [...counts],
    )
    const direct = call('navigate', { url: `${origin}/file?id=direct`, newTab: true })
    check(
      '下载：直接导航到附件仍出现审批',
      await until("document.querySelector('[data-status=pending] [data-download-allow]')"),
    )
    const directEntry = required(downloads.list().at(-1))
    await page(`${row(directEntry.id)}.querySelector('[data-download-allow]').click()`)
    const directResult = await direct
    check(
      '下载：附件导航不把 ERR_ABORTED 当失败误导 Agent 重试',
      directResult.success && textOf(directResult).includes('returned a download'),
      textOf(directResult),
    )
    check(
      '下载：直接附件导航完成且仍只请求一次',
      (await awaitState(() => downloads.list().at(-1)?.status === 'completed')) &&
        counts.get('direct') === 1,
    )
    check(
      '下载：所有成功路径位于隔离 Downloads',
      saved.every((path) => path.startsWith(`${app.getPath('downloads')}/`) && existsSync(path)),
    )
  } finally {
    shell.showItemInFolder = originalReveal
    for (const tab of host.list())
      if (tab.kind === 'agent' && tab.url.startsWith(origin)) host.close(tab.id)
    server.closeAllConnections()
    server.close()
    await user.load('about:blank', 5000)
  }
}
