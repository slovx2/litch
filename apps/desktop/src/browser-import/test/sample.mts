// 自造的样本资料：单测和样本模式（LITCH_BROWSER_IMPORT_FAKE=<目录>）用。目录当成假的主目录，按平台摆出来源浏览器的资料：
// Local State、profiles.ini、真的 History 和 places.sqlite（自己建表写入），Cookie 和密码库只放个空文件表示“有”，
// 假读取器要交的条目写在各资料目录的 litch-fake-protected.json 里。值都是编的，和任何真实账号无关。
//
// 样本里有（Mac、Windows 一样，Windows 上 Chrome 默认要管理员同意，见 fake-reader.mts）：
//   Google Chrome  “个人”（默认，带账号）：Cookie 7 条（导入 4、过期 1、分区 1、`__Host-` 不合规 1）；
//                  密码 3 条（安卓应用 1 条算无效）；浏览记录 5 条访问（chrome:// 1 条算无效、子框架 1 条和 90 天前 1 条不读）
//                  “工作”：Cookie 读到时浏览器开着（locked），密码 1 条，浏览记录 1 条
//   Microsoft Edge “Default”：Cookie 和密码都是用户拒了系统授权（denied），浏览记录 2 条
//   Brave          “Default”：读之前等 4 秒（给取消用），Cookie 20 条
//   Vivaldi        “Default”：资料目录里什么都没有
//   Firefox        “default-release”（默认）：Cookie 2 条、密码 1 条（读坏 1 条，partial）、浏览记录 3 条
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { chromiumRoots, firefoxRoots, type ImportEnv, sampleEnv } from '../browsers.mjs'
import type { ImportedCookie, ImportedPassword } from '../protected-types.mjs'
import type { BrowserId } from '../types.mjs'
import { FAKE_PROTECTED_FILE, type FakeProfileData } from './fake-reader.mjs'

export const SAMPLE_MARKER = '.litch-browser-import-sample'

const DAY_MS = 24 * 60 * 60 * 1000
const WEBKIT_EPOCH_OFFSET_MS = 11644473600000n

export interface SampleVisit {
  url: string
  title: string
  /** Unix 毫秒 */
  at: number
  /** Chromium 的 transition（默认 0 = LINK）或 Firefox 的 visit_type（默认 1 = LINK） */
  type?: number
}

const touch = (file: string, content = '') => {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, content)
}

export function writeChromiumHistory(file: string, visits: SampleVisit[]): void {
  mkdirSync(dirname(file), { recursive: true })
  const db = new DatabaseSync(file)
  try {
    db.exec(`
      CREATE TABLE urls(id INTEGER PRIMARY KEY, url LONGVARCHAR, title LONGVARCHAR,
        visit_count INTEGER DEFAULT 0 NOT NULL, typed_count INTEGER DEFAULT 0 NOT NULL,
        last_visit_time INTEGER NOT NULL, hidden INTEGER DEFAULT 0 NOT NULL);
      CREATE TABLE visits(id INTEGER PRIMARY KEY, url INTEGER NOT NULL, visit_time INTEGER NOT NULL,
        from_visit INTEGER, transition INTEGER DEFAULT 0 NOT NULL, segment_id INTEGER,
        visit_duration INTEGER DEFAULT 0 NOT NULL);`)
    const ids = new Map<string, number>()
    const addUrl = db.prepare('INSERT INTO urls(url, title, last_visit_time) VALUES (?, ?, ?)')
    const addVisit = db.prepare('INSERT INTO visits(url, visit_time, transition) VALUES (?, ?, ?)')
    for (const visit of visits) {
      // 1601 年起的微秒，超出了 Number 能精确表示的范围，用 BigInt
      const time = (BigInt(visit.at) + WEBKIT_EPOCH_OFFSET_MS) * 1000n
      let id = ids.get(visit.url)
      if (id === undefined) {
        id = Number(addUrl.run(visit.url, visit.title, time).lastInsertRowid)
        ids.set(visit.url, id)
      }
      addVisit.run(id, time, visit.type ?? 0x30000000)
    }
  } finally {
    db.close()
  }
}

export function writeFirefoxPlaces(file: string, visits: SampleVisit[]): void {
  mkdirSync(dirname(file), { recursive: true })
  const db = new DatabaseSync(file)
  try {
    db.exec(`
      CREATE TABLE moz_places(id INTEGER PRIMARY KEY, url LONGVARCHAR, title LONGVARCHAR,
        visit_count INTEGER DEFAULT 0, last_visit_date INTEGER);
      CREATE TABLE moz_historyvisits(id INTEGER PRIMARY KEY, from_visit INTEGER, place_id INTEGER,
        visit_date INTEGER, visit_type INTEGER, session INTEGER);`)
    const ids = new Map<string, number>()
    const addPlace = db.prepare(
      'INSERT INTO moz_places(url, title, last_visit_date) VALUES (?, ?, ?)',
    )
    const addVisit = db.prepare(
      'INSERT INTO moz_historyvisits(place_id, visit_date, visit_type) VALUES (?, ?, ?)',
    )
    for (const visit of visits) {
      const time = visit.at * 1000
      let id = ids.get(visit.url)
      if (id === undefined) {
        id = Number(addPlace.run(visit.url, visit.title, time).lastInsertRowid)
        ids.set(visit.url, id)
      }
      addVisit.run(id, time, visit.type ?? 1)
    }
  } finally {
    db.close()
  }
}

/** 样本里这个 Chromium 系来源的资料根目录（Windows 上的 Arc 是商店包，发布者哈希随便编一个） */
export function sampleChromiumRoot(env: ImportEnv, browser: Exclude<BrowserId, 'firefox'>): string {
  if (env.platform === 'win32' && browser === 'arc') {
    const local = env.localAppData ?? join(env.home, 'AppData', 'Local')
    return join(
      local,
      'Packages',
      'TheBrowserCompany.Arc_sample00000',
      'LocalCache',
      'Local',
      'Arc',
      'User Data',
    )
  }
  const [root] = chromiumRoots(browser, env)
  if (!root) throw new Error(`no ${browser} on ${env.platform}`)
  return root
}

export interface SampleChromiumProfile {
  dir: string
  name?: string
  account?: string
  /** 摆哪几样文件 */
  cookies?: boolean
  passwords?: boolean
  history?: SampleVisit[]
  fake?: FakeProfileData
}

/** 摆一个 Chromium 系来源：Local State 加各资料目录 */
export function writeChromium(
  root: string,
  profiles: SampleChromiumProfile[],
  lastUsed?: string,
): void {
  const infoCache: Record<string, Record<string, string>> = {}
  for (const profile of profiles) {
    const info: Record<string, string> = {}
    if (profile.name) info.name = profile.name
    if (profile.account) info.user_name = profile.account
    infoCache[profile.dir] = info
    const dir = join(root, profile.dir)
    mkdirSync(dir, { recursive: true })
    if (profile.cookies) touch(join(dir, 'Network', 'Cookies'))
    if (profile.passwords) touch(join(dir, 'Login Data'))
    if (profile.history) writeChromiumHistory(join(dir, 'History'), profile.history)
    if (profile.fake) touch(join(dir, FAKE_PROTECTED_FILE), JSON.stringify(profile.fake, null, 2))
  }
  const state = { profile: { info_cache: infoCache, ...(lastUsed ? { last_used: lastUsed } : {}) } }
  touch(join(root, 'Local State'), JSON.stringify(state))
}

export interface SampleFirefoxProfile {
  path: string
  name: string
  isDefault?: boolean
  cookies?: boolean
  passwords?: boolean
  history?: SampleVisit[]
  fake?: FakeProfileData
}

/** 摆一个 Firefox：profiles.ini 加各资料目录（都是相对路径） */
export function writeFirefox(root: string, profiles: SampleFirefoxProfile[]): void {
  const lines: string[] = ['[General]', 'StartWithLastProfile=1', 'Version=2', '']
  const preferred = profiles.find((profile) => profile.isDefault)
  if (preferred)
    lines.push('[Install0123456789ABCDEF]', `Default=${preferred.path}`, 'Locked=1', '')
  profiles.forEach((profile, index) => {
    lines.push(`[Profile${index}]`, `Name=${profile.name}`, 'IsRelative=1', `Path=${profile.path}`)
    if (profile.isDefault) lines.push('Default=1')
    lines.push('')
    const dir = join(root, profile.path)
    mkdirSync(dir, { recursive: true })
    if (profile.cookies) touch(join(dir, 'cookies.sqlite'))
    if (profile.passwords) touch(join(dir, 'logins.json'), '{"logins":[]}')
    if (profile.history) writeFirefoxPlaces(join(dir, 'places.sqlite'), profile.history)
    if (profile.fake) touch(join(dir, FAKE_PROTECTED_FILE), JSON.stringify(profile.fake, null, 2))
  })
  touch(join(root, 'profiles.ini'), lines.join('\n'))
}

const sec = (ms: number) => Math.floor(ms / 1000)

const cookie = (
  fields: Partial<ImportedCookie> & { host: string; name: string },
): ImportedCookie => ({
  value: `sample-${fields.name}`,
  path: '/',
  secure: true,
  httpOnly: false,
  sameSite: 'lax',
  ...fields,
})

const password = (
  origin: string,
  username: string,
  store: ImportedPassword['store'] = 'profile',
): ImportedPassword => ({
  origin,
  url: `${origin}/login`,
  username,
  password: `sample-password-${username}`,
  store,
})

/** 在 dir 下摆一整套样本（见文件开头）。now：浏览记录按它往前算 */
export function writeSample(
  dir: string,
  platform: NodeJS.Platform = process.platform,
  now = Date.now(),
): ImportEnv {
  const env = sampleEnv(dir, platform)
  const ago = (days: number) => now - days * DAY_MS
  const year = sec(now) + 365 * 24 * 60 * 60

  writeChromium(
    sampleChromiumRoot(env, 'chrome'),
    [
      {
        dir: 'Default',
        name: '个人',
        account: 'sample@example.com',
        cookies: true,
        passwords: true,
        history: [
          { url: 'https://example.com/', title: 'Example', at: ago(1) },
          { url: 'https://docs.example.org/guide', title: 'Guide', at: ago(10) },
          { url: 'chrome://settings/', title: 'Settings', at: ago(2) },
          { url: 'https://ads.example.net/frame', title: '', at: ago(2), type: 3 },
          { url: 'https://old.example.com/', title: 'Old', at: ago(120) },
        ],
        fake: {
          cookies: {
            items: [
              cookie({ host: 'example.com', name: 'session', expires: year, httpOnly: true }),
              cookie({ host: '.example.com', name: 'prefs', expires: year }),
              cookie({ host: 'docs.example.org', name: 'tab' }),
              cookie({ host: 'plain.example.net', name: 'http', secure: false, expires: year }),
              cookie({ host: 'example.com', name: 'gone', expires: sec(ago(1)) }),
              cookie({
                host: 'embed.example.net',
                name: 'chips',
                expires: year,
                partitionTopSite: 'https://example.com',
              }),
              cookie({ host: '.example.com', name: '__Host-bad', expires: year }),
            ],
          },
          passwords: {
            items: [
              password('https://accounts.example.com', 'sample-user'),
              password('https://shop.example.org', 'buyer', 'account'),
              { ...password('https://x', 'app'), origin: 'android://sample@com.example.app/' },
            ],
          },
        },
      },
      {
        dir: 'Profile 1',
        name: '工作',
        cookies: true,
        passwords: true,
        history: [{ url: 'https://work.example.com/', title: 'Work', at: ago(3) }],
        fake: {
          cookies: { status: 'locked', discovered: 0, error: 'The Cookies database is in use.' },
          passwords: { items: [password('https://work.example.com', 'worker')] },
        },
      },
    ],
    'Default',
  )

  writeChromium(sampleChromiumRoot(env, 'edge'), [
    {
      dir: 'Default',
      cookies: true,
      passwords: true,
      history: [
        { url: 'https://edge.example.com/', title: 'Edge home', at: ago(4) },
        { url: 'https://edge.example.com/news', title: 'News', at: ago(5) },
      ],
      fake: {
        cookies: { status: 'denied', error: 'Keychain access was denied.' },
        passwords: { status: 'denied', error: 'Keychain access was denied.' },
      },
    },
  ])

  writeChromium(sampleChromiumRoot(env, 'brave'), [
    {
      dir: 'Default',
      cookies: true,
      fake: {
        delayMs: 4000,
        cookies: {
          items: Array.from({ length: 20 }, (_, index) =>
            cookie({ host: `site${index}.example.com`, name: 'id', expires: year }),
          ),
        },
      },
    },
  ])

  writeChromium(sampleChromiumRoot(env, 'vivaldi'), [{ dir: 'Default' }])

  const [firefoxRoot] = firefoxRoots(env)
  if (firefoxRoot) {
    writeFirefox(firefoxRoot, [
      {
        path: 'Profiles/sample.default-release',
        name: 'default-release',
        isDefault: true,
        cookies: true,
        passwords: true,
        history: [
          { url: 'https://mozilla.example.org/', title: 'Mozilla sample', at: ago(1) },
          { url: 'https://mozilla.example.org/a', title: 'A', at: ago(2) },
          { url: 'about:config', title: '', at: ago(2) },
          { url: 'https://embed.example.org/', title: '', at: ago(2), type: 8 },
        ],
        fake: {
          cookies: {
            items: [
              cookie({ host: '.mozilla.example.org', name: 'ff', expires: year }),
              cookie({ host: 'mozilla.example.org', name: 'ffsession' }),
            ],
          },
          passwords: {
            status: 'partial',
            failed: 1,
            items: [password('https://mozilla.example.org', 'fox')],
          },
        },
      },
      { path: 'Profiles/sample.default', name: 'default' },
    ])
  }
  touch(join(dir, SAMPLE_MARKER), `${new Date(now).toISOString()}\n`)
  return env
}

/** 样本模式用：目录里还没有样本（没有标记文件）就摆一套，有了就原样用（验收时可以手改） */
export function ensureSample(dir: string, platform: NodeJS.Platform = process.platform): ImportEnv {
  if (existsSync(join(dir, SAMPLE_MARKER))) return sampleEnv(dir, platform)
  return writeSample(dir, platform)
}
