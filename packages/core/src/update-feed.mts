// 应用自己的更新：三个端（macOS、Windows、安卓）都看同一份更新清单 litch-update.json。
// 清单由发版流程（.github/workflows/release.yml）生成、挂在每一版的发布页上；客户端取“最新一版”下面的那一份，
// 草稿和预发布不会被当成最新，人公开之前谁也收不到。
//
// 清单的样子：
//   {
//     "version": "0.9.0",
//     "pubDate": "2026-10-18T08:00:00Z",
//     "notesUrl": "https://github.com/slovx2/litch/releases/tag/v0.9.0",
//     "assets": {
//       "macos-arm64":   { "url": "…/Litch-0.9.0-macos-arm64.zip",          "sha256": "…", "size": 123 },
//       "windows-x64":   { "url": "…/Litch-0.9.0-windows-x64-setup.exe",    "sha256": "…", "size": 123 },
//       "android-arm64": { "url": "…/Litch-0.9.0-android-arm64.apk",        "sha256": "…", "size": 123, "versionCode": 9000 }
//     },
//     "currentRelease": "0.9.0",
//     "releases": [{ "version": "0.9.0", "updateTo": { "version": "0.9.0", "name": "Litch 0.9.0", "notes": "", "pub_date": "…", "url": "…zip" } }]
//   }
// 最后两项是给 macOS 上 Electron 自带的更新器（Squirrel.Mac 的 JSON 格式）读的，指向的就是 macos-arm64 那个 zip；
// 这里不读它们。某个端这一版没出包，assets 里就没有那一项，那个端照旧不提示。
//
// 纯逻辑，不碰网络和文件：取清单、下载、安装各端自己做。

/** 清单的固定地址：总是最新一个正式版的那一份 */
export const UPDATE_FEED_URL =
  'https://github.com/slovx2/litch/releases/latest/download/litch-update.json'

/** 多久查一次（启动后先等一会儿查一次，之后按这个间隔） */
export const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000

export type UpdatePlatform = 'macos-arm64' | 'windows-x64' | 'android-arm64'

export interface UpdateAsset {
  url: string
  /** 小写十六进制 */
  sha256: string
  size: number
  /** 只有安卓：安装包里的 versionCode */
  versionCode?: number
}

export interface UpdateFeed {
  version: string
  pubDate: string
  notesUrl: string
  assets: Partial<Record<UpdatePlatform, UpdateAsset>>
}

const PLATFORMS: readonly UpdatePlatform[] = ['macos-arm64', 'windows-x64', 'android-arm64']

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

// 核心不带浏览器的类型（没有 URL），按字面查：https:// 后面跟主机名
const httpsUrl = (value: unknown): value is string =>
  typeof value === 'string' && /^https:\/\/[^\s/?#]+(?:[/?#]\S*)?$/.test(value)

/**
 * 读一份清单。形状不对就抛错（不猜）：版本号要能按语义化版本读，地址要是 https，校验和是 64 位十六进制。
 * allowHttp 只给开发和验收用（本机起的假清单服务是 http）
 */
export function parseUpdateFeed(value: unknown, options: { allowHttp?: boolean } = {}): UpdateFeed {
  const okUrl = (url: unknown): url is string =>
    httpsUrl(url) ||
    (options.allowHttp === true && typeof url === 'string' && url.startsWith('http://'))
  if (!isObject(value)) throw new Error('更新清单格式错误')
  const { version, pubDate, notesUrl, assets } = value
  if (typeof version !== 'string' || !parseVersion(version)) {
    throw new Error(`更新清单的版本号无效：${String(version)}`)
  }
  if (!isObject(assets)) throw new Error('更新清单缺少 assets')
  const picked: UpdateFeed['assets'] = {}
  for (const platform of PLATFORMS) {
    const asset = assets[platform]
    if (asset === undefined) continue
    if (!isObject(asset)) throw new Error(`更新清单中 ${platform} 的格式错误`)
    const { url, sha256, size, versionCode } = asset
    if (!okUrl(url)) throw new Error(`更新清单中 ${platform} 的地址无效：${String(url)}`)
    if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256)) {
      throw new Error(`更新清单中 ${platform} 的校验和无效`)
    }
    if (typeof size !== 'number' || !Number.isSafeInteger(size) || size <= 0) {
      throw new Error(`更新清单中 ${platform} 的大小无效`)
    }
    if (
      versionCode !== undefined &&
      (typeof versionCode !== 'number' || !Number.isSafeInteger(versionCode))
    ) {
      throw new Error(`更新清单中 ${platform} 的 versionCode 无效`)
    }
    picked[platform] = { url, sha256, size, ...(versionCode === undefined ? {} : { versionCode }) }
  }
  return {
    version,
    pubDate: typeof pubDate === 'string' ? pubDate : '',
    notesUrl: okUrl(notesUrl) ? notesUrl : '',
    assets: picked,
  }
}

interface Version {
  core: [number, number, number]
  pre: string[]
}

function parseVersion(text: string): Version | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(
    text.trim(),
  )
  if (!match) return null
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    pre: match[4] ? match[4].split('.') : [],
  }
}

/**
 * 按语义化版本比：a 比 b 新是正数，旧是负数，一样是 0；有一边读不了是 null。
 * 带预发布的比同号的正式版旧；预发布逐段比，数字段按数值、比非数字段旧，前面都一样时段少的旧；+ 后面的不比
 */
export function compareVersions(a: string, b: string): number | null {
  const left = parseVersion(a)
  const right = parseVersion(b)
  if (!left || !right) return null
  for (const i of [0, 1, 2] as const) {
    const diff = left.core[i] - right.core[i]
    if (diff !== 0) return Math.sign(diff)
  }
  if (left.pre.length === 0 || right.pre.length === 0) {
    return left.pre.length === right.pre.length ? 0 : left.pre.length === 0 ? 1 : -1
  }
  for (let i = 0; i < Math.min(left.pre.length, right.pre.length); i++) {
    const x = left.pre[i] ?? ''
    const y = right.pre[i] ?? ''
    const xNum = /^\d+$/.test(x)
    const yNum = /^\d+$/.test(y)
    if (xNum && yNum) {
      const diff = Number(x) - Number(y)
      if (diff !== 0) return Math.sign(diff)
    } else if (xNum !== yNum) {
      return xNum ? -1 : 1
    } else if (x !== y) {
      return x < y ? -1 : 1
    }
  }
  return Math.sign(left.pre.length - right.pre.length)
}

export interface UpdateOffer {
  version: string
  notesUrl: string
  asset: UpdateAsset
}

/** 这一端该不该更新：清单比眼前这一版新、而且给这一端出了包，才给出要装的那一项 */
export function updateFor(
  feed: UpdateFeed,
  current: string,
  platform: UpdatePlatform,
): UpdateOffer | null {
  const asset = feed.assets[platform]
  if (!asset) return null
  const order = compareVersions(feed.version, current)
  if (order === null || order <= 0) return null
  return { version: feed.version, notesUrl: feed.notesUrl, asset }
}

/**
 * 更新这件事眼下走到哪了，各端的界面照它画：
 *   idle        没查过，或者关了自动检查
 *   checking    正在取清单
 *   latest      已经是最新（version 是清单上的版本）
 *   available   有新版本，还没下（安卓等人点；桌面马上自己开始下）
 *   downloading 正在下（progress 是 0 到 1，不知道总大小时没有）
 *   ready       下好了，等重启（桌面）或等系统安装器（安卓）
 *   failed      这一趟没成（message 是给人看的原因），过一会儿或者手动再查
 */
export type UpdateState =
  | { phase: 'idle' }
  | { phase: 'checking' }
  | { phase: 'latest'; version: string; checkedAt: number }
  | { phase: 'available'; version: string; notesUrl: string }
  | { phase: 'downloading'; version: string; notesUrl: string; progress?: number }
  | { phase: 'ready'; version: string; notesUrl: string }
  | { phase: 'failed'; message: string; checkedAt: number }
