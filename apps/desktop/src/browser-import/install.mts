// 把“从别的浏览器导入”装进主进程：建管线，接上界面的消息（window.litchBrowser.import）。
// browser/install.mts 在装内置浏览器时调一次。密码库接上之前，密码在正式模式里报导不了。
//
// LITCH_BROWSER_IMPORT_FAKE=<样本目录>：样本模式，给真实窗口验收用，只在没打包时认（打包的应用里这个变量不起作用）。
// 目录当假的主目录（没有样本就摆一套，目录不空又不是样本时不写、什么来源都不列，见 test/sample.mts），读取器换成假的；
// 密码库没交进来时用内存里的假库。这些测试用的代码单独打成 dist/browser-import-fake.mjs、运行时按路径加载，不进正式包。
// Cookie 照样写进内置浏览器的分区，所以验收要用隔离的用户数据目录（LITCH_PROFILE）。
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { IpcMainInvokeEvent } from 'electron'
import { app, ipcMain } from 'electron'
import { currentEnv, type ImportEnv } from './browsers.mjs'
import { electronCookieJar } from './cookie-jar.mjs'
import type { SampleMode } from './fake-mode.mjs'
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
import type { PasswordSink } from './sinks.mjs'
import { createImportStateBook, importStateFile } from './state.mjs'
import { BROWSER_IDS, IMPORT_KINDS, type ImportRequest } from './types.mjs'

/** 样本模式起不来时用：一个来源都不列 */
const NOWHERE: ImportEnv = { platform: 'aix', home: '/nonexistent' }

/** 动态加载样本模式那一份（和 main.mjs 同目录）。路径是算出来的，打包工具不会把它并进主进程 */
async function loadSampleMode(dir: string): Promise<SampleMode> {
  const file = join(dirname(fileURLToPath(import.meta.url)), 'browser-import-fake.mjs')
  const mod = (await import(pathToFileURL(file).href)) as typeof import('./fake-mode.mjs')
  return mod.createSampleMode(dir)
}

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
}): Promise<Importer> {
  const fakeDir = app.isPackaged ? undefined : process.env.LITCH_BROWSER_IMPORT_FAKE
  const make = (env: () => ImportEnv, reader: ProtectedReader, passwords?: PasswordSink) =>
    createImporter({
      env,
      reader,
      cookies: electronCookieJar(),
      ...(passwords ? { passwords } : {}),
      state: createImportStateBook(importStateFile(options.userData)),
      log: (line) => console.error(`[browser-import] ${line}`),
    })
  const ready: Promise<Importer> = fakeDir
    ? loadSampleMode(fakeDir).then(
        (sample) => {
          console.error(`[browser-import] sample mode: ${fakeDir}`)
          return make(() => sample.env, sample.reader, options.passwords ?? sample.passwords)
        },
        (error: unknown) => {
          console.error(`[browser-import] sample mode unavailable: ${String(error)}`)
          return make(() => NOWHERE, createProtectedReader())
        },
      )
    : Promise.resolve(make(currentEnv, createProtectedReader(), options.passwords))

  ipcMain.handle(IMPORT_SOURCES, async (event) =>
    options.fromUi(event) ? (await ready).sources() : [],
  )
  ipcMain.handle(IMPORT_START, async (event, payload: unknown) => {
    if (!options.fromUi(event)) return null
    const request = parseImportRequest(payload)
    if (!request) throw new Error('bad import request')
    const sender = event.sender
    // 进度只发给开始导入的那个窗口
    return (await ready).start(request, (progress) => {
      if (!sender.isDestroyed()) sender.send(IMPORT_PROGRESS, progress)
    })
  })
  ipcMain.handle(IMPORT_CANCEL, async (event) => {
    if (options.fromUi(event)) (await ready).cancel()
  })
  ipcMain.handle(IMPORT_STATE, async (event) =>
    options.fromUi(event) ? (await ready).state() : {},
  )
  ipcMain.handle(IMPORT_DISMISS_BANNER, async (event) => {
    if (options.fromUi(event)) (await ready).dismissBanner()
  })
  return ready
}
