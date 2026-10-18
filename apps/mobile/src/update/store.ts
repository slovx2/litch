// 应用自己的更新（安卓）：取清单、比版本、人点了才下、对校验和、拉起系统安装器。设计见工作区
// design/harness-client/07-auto-update.md；清单的读法、版本比较、状态的形状在核心里（@litch/core 的 update-feed）。
// 状态放在模块里的一份快照上，界面用 useUpdate()（./use-update.ts）订阅；和核心、设备无关，模拟核心、测试夹具装法也照查。
//
// 失败（网络、清单、校验和、签名、装不了）只记进状态，由设置页的“关于”说原因，不弹窗；下次按间隔再查。
// 安装：系统安装器装没装上不回话。装上了应用会被换掉重启（缓存里那份安装包下次启动时清掉）；没装上、人取消了，
// 回到应用时状态还是 ready，横条和“关于”里都还能再点“安装”。
import {
  parseUpdateFeed,
  UPDATE_CHECK_INTERVAL_MS,
  UPDATE_FEED_URL,
  type UpdateOffer,
  type UpdateState,
  updateFor,
} from '@litch/core'
import { Directory, File, Paths } from 'expo-file-system'
import { AppState } from 'react-native'
import app from '../../app.json'
import { updater } from '../../modules/litch-update/src'
import { feedOverride, onFeedOverride } from './override'

/** 装着的这一版：就是 app.json 的 expo.version（打包时它也成了安装包的 versionName，shell/boot.ts 的 VERSION 也是它） */
export const CURRENT_VERSION: string = app.expo.version

/** 失败的种类，界面照它挑说法（文案 update.fail.*）；message 里放具体的那句（状态码、系统的原话） */
export type UpdateFailure =
  | 'network' // 取清单或下载时连不上、超时、状态码不对（还没有清单的发布页是 404）
  | 'feed' // 清单读不了
  | 'size' // 下下来的大小和清单上的不一样
  | 'checksum' // SHA-256 和清单上的不一样
  | 'package' // 不是 Litch 的安装包，或者版本不比眼前这一版新
  | 'signature' // 签名和眼前这个应用不是同一把钥匙，系统一定装不上
  | 'install' // 拉不起系统安装器

export type MobileUpdateState =
  | Exclude<UpdateState, { phase: 'failed' }>
  | (Extract<UpdateState, { phase: 'failed' }> & { reason: UpdateFailure })

export interface UpdateSnapshot {
  state: MobileUpdateState
  /** 眼下要装的那一版（清单里给安卓的那一项）；没有新版本时是 null */
  offer: UpdateOffer | null
  /** 下好、校验过的安装包（file:// 地址）；phase 是 ready 时才有 */
  apk: string | null
  /** 等人去系统设置里允许“安装未知应用”，回到应用时接着装 */
  needsPermission: boolean
}

const PLATFORM = 'android-arm64'
/** 启动后等多久查第一次 */
const FIRST_CHECK_DELAY_MS = 30_000
const FEED_TIMEOUT_MS = 20_000

let snapshot: UpdateSnapshot = {
  state: { phase: 'idle' },
  offer: null,
  apk: null,
  needsPermission: false,
}
let lastCheckAt = 0
/**
 * 下下来对不上的那一份（大小、校验和、包名、签名不对）和当时的失败：同一份文件再下也一样，
 * 之后查到的还是它（校验和相同）就不再出横条，“关于”里接着说那次的原因，等清单换了新的包
 */
let broken: { sha256: string; state: MobileUpdateState } | null = null
const listeners = new Set<() => void>()

function set(patch: Partial<UpdateSnapshot>) {
  snapshot = { ...snapshot, ...patch }
  for (const listener of listeners) listener()
}

function fail(reason: UpdateFailure, message: string) {
  set({
    state: { phase: 'failed', reason, message, checkedAt: Date.now() },
    apk: null,
    needsPermission: false,
  })
}

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

/** 带着失败种类的错误；别的错误（系统、网络库抛的）按 fallback 算。不写成 Error 的子类：转换后的类继承内置的 Error 时 instanceof 靠不住 */
type UpdateError = Error & { reason: UpdateFailure }

const updateError = (reason: UpdateFailure, message: string): UpdateError =>
  Object.assign(new Error(message), { reason })

const reasonOf = (error: unknown, fallback: UpdateFailure): UpdateFailure =>
  (error as Partial<UpdateError> | null)?.reason ?? fallback

export const getUpdate = (): UpdateSnapshot => snapshot

export function subscribeUpdate(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** 下载用的目录：缓存目录下的 updates/，系统空间紧张时可以清掉 */
const downloads = () => new Directory(Paths.cache, 'updates')

function clearDownloads() {
  const dir = downloads()
  if (dir.exists) dir.delete()
}

async function fetchFeed() {
  const override = feedOverride()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FEED_TIMEOUT_MS)
  let response: Response
  try {
    response = await fetch(override ?? UPDATE_FEED_URL, {
      headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' },
      signal: controller.signal,
    })
  } catch (error) {
    throw updateError('network', errorText(error))
  } finally {
    clearTimeout(timer)
  }
  if (!response.ok) {
    throw updateError('network', `HTTP ${response.status}`)
  }
  try {
    // 只有换成本机假清单时才允许 http
    return parseUpdateFeed(await response.json(), { allowHttp: override !== null })
  } catch (error) {
    throw updateError('feed', errorText(error))
  }
}

let checking: Promise<void> | null = null

/** 查一次。正在下的时候不查；已经有新版本（等人点、已下好）时查的过程不把横条收起来 */
export function checkForUpdate(): Promise<void> {
  if (snapshot.state.phase === 'downloading') return Promise.resolve()
  if (checking) return checking
  checking = (async () => {
    lastCheckAt = Date.now()
    const before = snapshot
    const quiet = before.state.phase === 'available' || before.state.phase === 'ready'
    if (!quiet) set({ state: { phase: 'checking' } })
    try {
      const feed = await fetchFeed()
      const offer = updateFor(feed, CURRENT_VERSION, PLATFORM)
      if (!offer) {
        set({
          state: { phase: 'latest', version: feed.version, checkedAt: Date.now() },
          offer: null,
          apk: null,
        })
        return
      }
      if (offer.asset.sha256 === broken?.sha256) {
        set({ state: broken.state, offer: null, apk: null })
        return
      }
      // 已经下好了同一版：留着，不用重下
      if (before.state.phase === 'ready' && before.offer?.asset.sha256 === offer.asset.sha256)
        return
      set({
        state: { phase: 'available', version: offer.version, notesUrl: offer.notesUrl },
        offer,
        apk: null,
        needsPermission: false,
      })
    } catch (error) {
      // 已经有新版本时再查没查成：手上那一版照旧可以装，不拿这次失败把它盖掉
      if (!quiet) fail(reasonOf(error, 'network'), errorText(error))
    } finally {
      checking = null
    }
  })()
  return checking
}

/** 人点了“更新”：下到缓存目录、对大小和 SHA-256、看包名和签名，都对了就拉起系统安装器 */
export async function downloadUpdate(): Promise<void> {
  const { state, offer } = snapshot
  if (state.phase === 'ready') return installUpdate()
  if (state.phase !== 'available' || !offer) return
  const { version, notesUrl, asset } = offer
  set({ state: { phase: 'downloading', version, notesUrl, progress: 0 } })
  let shown = 0
  let target: File | null = null
  try {
    clearDownloads()
    const dir = downloads()
    dir.create({ intermediates: true, idempotent: true })
    target = new File(dir, `Litch-${version}-${PLATFORM}.apk`)
    const file = await File.downloadFileAsync(asset.url, target, {
      idempotent: true,
      onProgress: ({ bytesWritten, totalBytes }) => {
        const total = totalBytes > 0 ? totalBytes : asset.size
        const progress = Math.min(1, bytesWritten / total)
        // 百分之一以上才换一次，免得每一小块都重画
        if (progress - shown < 0.01 && progress < 1) return
        shown = progress
        set({ state: { phase: 'downloading', version, notesUrl, progress } })
      },
    })
    target = file
    if (file.size !== asset.size) {
      throw updateError('size', `${file.size} ≠ ${asset.size}`)
    }
    const sha256 = await updater.sha256(file.uri)
    if (sha256 !== asset.sha256) {
      throw updateError('checksum', `SHA-256 ${sha256}`)
    }
    const info = await updater.inspect(file.uri)
    if (info.packageName !== app.expo.android.package) {
      throw updateError('package', info.packageName)
    }
    if (info.versionCode <= info.installedVersionCode) {
      const detail = `versionCode ${info.versionCode} ≤ ${info.installedVersionCode}`
      throw updateError('package', detail)
    }
    if (info.sameSigner === false) {
      throw updateError('signature', '')
    }
    set({ state: { phase: 'ready', version, notesUrl }, apk: file.uri })
  } catch (error) {
    // 下坏了、对不上的不留着
    try {
      if (target?.exists) target.delete()
    } catch {}
    const reason = reasonOf(error, 'network')
    fail(reason, errorText(error))
    if (reason !== 'network') broken = { sha256: asset.sha256, state: snapshot.state }
    return
  }
  return installUpdate()
}

/** 拉起系统安装器；还没允许“安装未知应用”就先打开那一页设置，回到应用时接着装 */
export function installUpdate(): void {
  const { state, apk } = snapshot
  if (state.phase !== 'ready' || !apk) return
  try {
    if (!updater.canInstall()) {
      set({ needsPermission: true })
      updater.openInstallSettings()
      return
    }
    set({ needsPermission: false })
    updater.install(apk)
  } catch (error) {
    fail('install', errorText(error))
  }
}

/**
 * 定时查：启动后等 30 秒查一次，之后回到前台时距上次查超过间隔再查；auto() 读的是“自动检查更新”开关，关了只在人点时查。
 * 回到前台时还顺手接着装（刚从设置里允许了“安装未知应用”回来）。返回停下的函数
 */
export function startUpdateSchedule(auto: () => boolean): () => void {
  // 启动时缓存里的安装包都是上一回的：装上了就没用了，没装上的下次再下
  if (snapshot.state.phase === 'idle') {
    try {
      clearDownloads()
    } catch {}
  }
  // 启动时 AppState 也会报一次 active：头 30 秒不按前台查，免得一启动就查
  let started = false
  const first = setTimeout(() => {
    started = true
    if (auto()) void checkForUpdate()
  }, FIRST_CHECK_DELAY_MS)
  const subscription = AppState.addEventListener('change', (next) => {
    if (next !== 'active') return
    // 没允许就回来了：needsPermission 留着，界面接着提示，再点“安装”再去设置
    if (snapshot.needsPermission && updater.canInstall()) installUpdate()
    if (started && auto() && Date.now() - lastCheckAt > UPDATE_CHECK_INTERVAL_MS) {
      void checkForUpdate()
    }
  })
  return () => {
    clearTimeout(first)
    subscription.remove()
  }
}

// 换了清单地址（测试链接）：从头来，马上查一次
onFeedOverride(() => {
  broken = null
  set({ state: { phase: 'idle' }, offer: null, apk: null, needsPermission: false })
  void checkForUpdate()
})
