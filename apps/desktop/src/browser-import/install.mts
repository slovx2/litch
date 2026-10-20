// 把“从别的浏览器导入”装进主进程：建管线，接上界面的消息（window.litchBrowser.import）。
// browser/install.mts 在装内置浏览器时调一次。密码库、浏览记录库接上之前，这两类在正式模式里报导不了。
//
// LITCH_BROWSER_IMPORT_FAKE=<样本目录>：样本模式，给真实窗口验收用。目录当假的主目录（没有样本就摆一套，见 test/sample.mts），
// 读取器换成假的（test/fake-reader.mts）；密码库、浏览记录库没交进来时用内存里的假库。Cookie 照样写进内置浏览器的分区，
// 所以验收要用隔离的用户数据目录（LITCH_PROFILE）。
import type { IpcMainInvokeEvent } from 'electron'
import { ipcMain } from 'electron'
import { currentEnv, type ImportEnv } from './browsers.mjs'
import { electronCookieJar } from './cookie-jar.mjs'
import {
  IMPORT_CANCEL,
  IMPORT_DISMISS_BANNER,
  IMPORT_PROGRESS,
  IMPORT_SOURCES,
  IMPORT_START,
  IMPORT_STATE,
} from './ipc.mjs'
import { createImporter, type Importer } from './pipeline.mjs'
import { createProtectedReader } from './protected/index.mjs'
import type { ProtectedReader } from './protected-types.mjs'
import type { HistorySink, PasswordSink } from './sinks.mjs'
import { createImportStateBook, importStateFile } from './state.mjs'
import { createFakeReader } from './test/fake-reader.mjs'
import { memoryHistorySink, memoryPasswordSink } from './test/fake-sinks.mjs'
import { ensureSample } from './test/sample.mjs'
import { BROWSER_IDS, IMPORT_KINDS, type ImportRequest } from './types.mjs'

/** 界面传来的请求：形状不对就是 null（只认这几个字段，多的丢掉） */
export function parseImportRequest(payload: unknown): ImportRequest | null {
  if (!payload || typeof payload !== 'object') return null
  const raw = payload as Record<string, unknown>
  const browser = BROWSER_IDS.find((id) => id === raw.browser)
  if (!browser || typeof raw.profileId !== 'string' || raw.profileId === '') return null
  if (!Array.isArray(raw.kinds)) return null
  const kinds = IMPORT_KINDS.filter((kind) => (raw.kinds as unknown[]).includes(kind))
  if (kinds.length === 0) return null
  const request: ImportRequest = {
    browser,
    profileId: raw.profileId,
    kinds,
    allowElevated: raw.allowElevated === true,
  }
  if (Array.isArray(raw.cookieDomains)) {
    request.cookieDomains = raw.cookieDomains.filter(
      (item): item is string => typeof item === 'string',
    )
  }
  return request
}

export function installBrowserImport(options: {
  /** 是不是界面自己的主框架发来的（browser/install.mts 的 fromUi） */
  fromUi(event: IpcMainInvokeEvent): boolean
  userData: string
  passwords?: PasswordSink
  history?: HistorySink
}): Importer {
  const fakeDir = process.env.LITCH_BROWSER_IMPORT_FAKE
  let env: () => ImportEnv = currentEnv
  let reader: ProtectedReader
  let passwords = options.passwords
  let history = options.history
  if (fakeDir) {
    const sample = ensureSample(fakeDir)
    env = () => sample
    reader = createFakeReader()
    passwords ??= memoryPasswordSink()
    history ??= memoryHistorySink()
    console.error(`[browser-import] sample mode: ${fakeDir}`)
  } else {
    reader = createProtectedReader()
  }
  const importer = createImporter({
    env,
    reader,
    cookies: electronCookieJar(),
    ...(passwords ? { passwords } : {}),
    ...(history ? { history } : {}),
    state: createImportStateBook(importStateFile(options.userData)),
    log: (line) => console.error(`[browser-import] ${line}`),
  })

  ipcMain.handle(IMPORT_SOURCES, (event) => (options.fromUi(event) ? importer.sources() : []))
  ipcMain.handle(IMPORT_START, async (event, payload: unknown) => {
    if (!options.fromUi(event)) return null
    const request = parseImportRequest(payload)
    if (!request) throw new Error('bad import request')
    const sender = event.sender
    // 进度只发给开始导入的那个窗口
    return importer.start(request, (progress) => {
      if (!sender.isDestroyed()) sender.send(IMPORT_PROGRESS, progress)
    })
  })
  ipcMain.handle(IMPORT_CANCEL, (event) => {
    if (options.fromUi(event)) importer.cancel()
  })
  ipcMain.handle(IMPORT_STATE, (event) => (options.fromUi(event) ? importer.state() : {}))
  ipcMain.handle(IMPORT_DISMISS_BANNER, (event) => {
    if (options.fromUi(event)) importer.dismissBanner()
  })
  return importer
}
