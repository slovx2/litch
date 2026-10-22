// 应用自己的更新。清单的读法、版本比较在核心里（update-feed.mts），
// 这里管取清单、下载、到点换：
//   macOS    Electron 自带的 autoUpdater（Squirrel.Mac，JSON 格式）照同一份清单下 zip；它会核对新应用的签名满足
//            眼前这个应用的指定要求（同一个开发者身份），不满足就不装。下好后点“重启以更新”换，不点的话下次退出时它自己换。
//   Windows  自己下安装程序到用户数据目录的 updates/，边下边算 SHA-256、对清单；退出时（点了“重启以更新”或者平常退出）
//            由主进程先请本机的设备服务闲着就停下，再静默跑安装程序（见 main.mts 的 will-quit 和 packaging/litch.iss）。
//   别的平台（Linux、Intel 的 Mac）清单里没有对应的包，不查。
// 只在装好的应用里查（没打包时不查）；LITCH_UPDATE_FEED 可以换成本机起的假清单（允许 http），开发和验收用。
import { createHash } from 'node:crypto'
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
} from 'node:fs'
import { join } from 'node:path'
import {
  parseUpdateFeed,
  UPDATE_CHECK_INTERVAL_MS,
  type UpdateOffer,
  type UpdatePlatform,
  type UpdateState,
  updateFor,
} from '@litch/core'
import { autoUpdater, net } from 'electron'

/** 启动后等多久查第一次：别和启动时的一堆事挤在一起 */
const FIRST_CHECK_MS = 30_000

export interface UpdaterOptions {
  version: string
  /** 这个平台出不出更新；null 是不出 */
  platform: UpdatePlatform | null
  /** 用户数据目录：Windows 的安装程序下到这里的 updates/ */
  dataDir: string
  feedUrl: string
  /** 允许 http 的清单和下载地址（只在 LITCH_UPDATE_FEED 换成本机假服务时） */
  allowHttp: boolean
  /** 自动检查开着没有（设置里那个开关）；关着时只有手动查 */
  auto(): boolean
  onState(state: UpdateState): void
  log(message: string): void
}

export interface Updater {
  state(): UpdateState
  /** 开始按间隔自动查（开关关着时到点也不查） */
  start(): void
  /** 现在查一次；已经在查、在下、下好了就不重来 */
  check(): Promise<void>
  /** Windows：下好了的安装程序在哪，退出时由主进程去跑。别的平台是 null */
  installer(): string | null
  /** macOS：换上下好的新版本并重启。调之前退出前的事（终端怎么办）要已经办完 */
  quitAndInstall(): void
  stop(): void
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error))

export function createUpdater(options: UpdaterOptions): Updater {
  const { platform, version } = options
  let state: UpdateState = { phase: 'idle' }
  let timer: NodeJS.Timeout | null = null
  let squirrelReady = false
  let installerPath: string | null = null
  const updatesDir = join(options.dataDir, 'updates')

  const set = (next: UpdateState) => {
    state = next
    options.onState(next)
  }
  const fail = (error: unknown) => {
    options.log(`更新没成：${message(error)}`)
    set({ phase: 'failed', message: message(error), checkedAt: Date.now() })
  }
  const busy = () =>
    state.phase === 'checking' || state.phase === 'downloading' || state.phase === 'ready'

  if (platform === 'macos-arm64') {
    autoUpdater.on('error', (error) => {
      if (state.phase === 'downloading' || state.phase === 'checking') fail(error)
    })
    autoUpdater.on('update-downloaded', (_event, _notes, name) => {
      squirrelReady = true
      if (state.phase === 'downloading') set({ ...state, phase: 'ready' })
      options.log(`新版本已下好：${name}`)
    })
    autoUpdater.on('update-not-available', () => {
      // 清单说有新的、Squirrel 却说没有：清单和它读的那两项对不上（不该发生），照实报
      if (state.phase === 'downloading') fail(new Error('更新清单与 Squirrel 读取的版本不一致'))
    })
  }

  async function fetchFeed() {
    const response = await net.fetch(options.feedUrl, { cache: 'no-store' })
    if (!response.ok) throw new Error(`获取更新清单失败：HTTP ${response.status}`)
    return parseUpdateFeed(await response.json(), { allowHttp: options.allowHttp })
  }

  /** Windows：下安装程序，边下边算校验和；同一版已经下好、校验和对得上的直接用 */
  async function download(offer: UpdateOffer): Promise<string> {
    mkdirSync(updatesDir, { recursive: true })
    const target = join(updatesDir, `Litch-${offer.version}-setup.exe`)
    // 别的版本留下的都清掉，只留要装的这一份
    for (const name of readdirSync(updatesDir)) {
      if (join(updatesDir, name) !== target) rmSync(join(updatesDir, name), { force: true })
    }
    if (existsSync(target)) {
      const sum = createHash('sha256').update(readFileSync(target)).digest('hex')
      if (sum === offer.asset.sha256) return target
      rmSync(target, { force: true })
    }
    const response = await net.fetch(offer.asset.url, { cache: 'no-store' })
    if (!response.ok || !response.body) throw new Error(`下载失败：HTTP ${response.status}`)
    const part = `${target}.part`
    const hash = createHash('sha256')
    const out = createWriteStream(part)
    let received = 0
    let shown = -1
    try {
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        hash.update(chunk)
        received += chunk.byteLength
        if (!out.write(chunk)) await new Promise<void>((resolve) => out.once('drain', resolve))
        const progress = Math.min(1, received / offer.asset.size)
        // 百分之一报一次，别每块都发给界面
        if (Math.floor(progress * 100) !== shown) {
          shown = Math.floor(progress * 100)
          set({ phase: 'downloading', version: offer.version, notesUrl: offer.notesUrl, progress })
        }
      }
      await new Promise<void>((resolve, reject) =>
        out.end((error?: Error | null) => (error ? reject(error) : resolve())),
      )
    } catch (error) {
      out.destroy()
      rmSync(part, { force: true })
      throw error
    }
    const sum = hash.digest('hex')
    if (received !== offer.asset.size || sum !== offer.asset.sha256) {
      rmSync(part, { force: true })
      throw new Error('下载的安装程序与更新清单不一致（大小或校验和不同），已放弃使用')
    }
    renameSync(part, target)
    return target
  }

  async function check(): Promise<void> {
    if (!platform || busy()) return
    set({ phase: 'checking' })
    try {
      const feed = await fetchFeed()
      const offer = updateFor(feed, version, platform)
      if (!offer) {
        set({ phase: 'latest', version: feed.version, checkedAt: Date.now() })
        return
      }
      set({ phase: 'downloading', version: offer.version, notesUrl: offer.notesUrl })
      if (platform === 'macos-arm64') {
        if (squirrelReady) {
          set({ phase: 'ready', version: offer.version, notesUrl: offer.notesUrl })
          return
        }
        autoUpdater.setFeedURL({ url: options.feedUrl, serverType: 'json' })
        autoUpdater.checkForUpdates()
        return
      }
      installerPath = await download(offer)
      set({ phase: 'ready', version: offer.version, notesUrl: offer.notesUrl })
    } catch (error) {
      fail(error)
    }
  }

  return {
    state: () => state,
    start() {
      if (!platform || timer) return
      const tick = () => {
        if (options.auto()) void check()
      }
      timer = setTimeout(() => {
        tick()
        timer = setInterval(tick, UPDATE_CHECK_INTERVAL_MS)
      }, FIRST_CHECK_MS)
    },
    check,
    installer: () => (state.phase === 'ready' ? installerPath : null),
    quitAndInstall() {
      if (platform === 'macos-arm64' && squirrelReady) autoUpdater.quitAndInstall()
    },
    stop() {
      if (timer) clearTimeout(timer)
      timer = null
    },
  }
}

/** 这台机器出不出更新、出哪一份 */
export function updatePlatform(): UpdatePlatform | null {
  if (process.platform === 'darwin' && process.arch === 'arm64') return 'macos-arm64'
  if (process.platform === 'win32' && process.arch === 'x64') return 'windows-x64'
  return null
}
