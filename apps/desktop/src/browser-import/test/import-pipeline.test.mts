// 管线：对着样本资料、假读取器、内存里的 Cookie 罐和假库，走导入的各条路：
// 条数、去重（不覆盖）、校验、域名筛选、取消、一次只一个、各种失败状态、明文不出现在交给界面的数据和日志里。
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { ImportEnv } from '../browsers.mjs'
import type { CookieJar, CookieSetDetails, ExistingCookie } from '../cookies.mjs'
import { createImporter, type ImporterOptions } from '../pipeline.mjs'
import type { ProtectedReader, ProtectedReadInput } from '../protected-types.mjs'
import { createImportStateBook, importStateFile } from '../state.mjs'
import type { ImportProgress, ImportRequest } from '../types.mjs'
import {
  createFakeReader,
  defaultFakeCapabilities,
  type FakeReaderOptions,
} from './fake-reader.mjs'
import { memoryPasswordSink } from './fake-sinks.mjs'
import { writeSample } from './sample.mjs'

const NOW = Date.UTC(2026, 9, 20, 12)

interface MemoryJar extends CookieJar {
  readonly cookies: CookieSetDetails[]
  readonly flushes: () => number
}

function memoryJar(
  existing: ExistingCookie[] = [],
  fail?: (details: CookieSetDetails) => boolean,
): MemoryJar {
  const cookies: CookieSetDetails[] = []
  let flushes = 0
  return {
    cookies,
    flushes: () => flushes,
    async list() {
      return [
        ...existing,
        ...cookies.map((cookie) => ({
          domain: cookie.domain ?? new URL(cookie.url).hostname,
          hostOnly: cookie.domain === undefined,
          name: cookie.name,
          path: cookie.path,
        })),
      ]
    },
    async set(details) {
      // 真的 Electron 拒绝时报的错里会带着值：不许漏出去
      if (fail?.(details)) throw new Error(`Failed to set cookie ${details.name}=${details.value}`)
      cookies.push({ ...details })
    },
    async flush() {
      flushes += 1
    },
  }
}

function setup(
  t: { after(fn: () => void): void },
  overrides: Partial<ImporterOptions> & { reader?: ProtectedReader; fake?: FakeReaderOptions } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), 'litch-import-pipeline-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const env: ImportEnv = writeSample(join(dir, 'home'), 'darwin', NOW)
  const calls: ProtectedReadInput[] = []
  const logs: string[] = []
  const jar = (overrides.cookies as MemoryJar | undefined) ?? memoryJar()
  const passwords = memoryPasswordSink()
  const userData = join(dir, 'userData')
  const importer = createImporter({
    env: () => env,
    reader: overrides.reader ?? createFakeReader({ calls, ...overrides.fake }),
    cookies: jar,
    passwords,
    state: createImportStateBook(importStateFile(userData)),
    now: () => NOW,
    log: (line) => logs.push(line),
    ...overrides,
  })
  return { dir, env, importer, jar, passwords, calls, logs, userData }
}

const chrome = (fields: Partial<ImportRequest> = {}): ImportRequest => ({
  browser: 'chrome',
  profileId: 'Default',
  kinds: ['cookies', 'passwords'],
  allowElevated: false,
  ...fields,
})

test('从 Chrome 导一次：逐类的条数，Cookie 按规矩写进去并落盘', async (t) => {
  const { importer, jar, passwords, calls } = setup(t)
  const progress: ImportProgress[] = []
  const outcome = await importer.start(chrome(), (item) => progress.push(item))
  assert.deepEqual(outcome, {
    kinds: {
      cookies: {
        status: 'ok',
        discovered: 7,
        imported: 4,
        skippedExisting: 0,
        skippedInvalid: 3,
        failed: 0,
        error:
          '1 partitioned cookie(s) skipped: the built-in browser cannot store partitioned cookies.',
      },
      passwords: {
        status: 'ok',
        discovered: 3,
        imported: 2,
        skippedExisting: 0,
        skippedInvalid: 1,
        failed: 0,
      },
    },
  })
  // 读取器一次读 Cookie 和密码，拿到的是重新发现的路径
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0]?.kinds, ['cookies', 'passwords'])
  assert.ok(calls[0]?.profileDir.endsWith(join('Google', 'Chrome', 'Default')))
  assert.equal(calls[0]?.cookieDomains, undefined)
  // 进度按类推
  assert.deepEqual(
    progress.map((item) => `${item.kind}:${item.phase}`),
    [
      'cookies:reading',
      'passwords:reading',
      'cookies:writing',
      'cookies:done',
      'passwords:writing',
      'passwords:done',
    ],
  )
  const byName = Object.fromEntries(jar.cookies.map((cookie) => [cookie.name, cookie]))
  assert.deepEqual(Object.keys(byName).sort(), ['http', 'prefs', 'session', 'tab'])
  // 只给这台主机的不带 domain，含子域的带上；会话 Cookie 没有过期时间；不安全的走 http
  assert.equal(byName.session?.domain, undefined)
  assert.equal(byName.session?.url, 'https://example.com/')
  assert.equal(byName.session?.httpOnly, true)
  assert.equal(byName.prefs?.domain, '.example.com')
  assert.equal(byName.tab?.expirationDate, undefined)
  assert.equal(byName.http?.url, 'http://plain.example.net/')
  assert.equal(jar.flushes(), 1)
  assert.deepEqual(
    passwords.saved.map((item) => [item.origin, item.username, item.source]),
    [
      ['https://accounts.example.com', 'sample-user', 'chrome:Default'],
      ['https://shop.example.org', 'buyer', 'chrome:Default'],
    ],
  )
})

test('再导一次全是“已存在跳过”；内置浏览器里已有的 Cookie 不覆盖', async (t) => {
  const jar = memoryJar([{ domain: 'example.com', hostOnly: true, name: 'session', path: '/' }])
  const { importer } = setup(t, { cookies: jar })
  const first = await importer.start(chrome())
  assert.equal(first.kinds.cookies?.imported, 3)
  assert.equal(first.kinds.cookies?.skippedExisting, 1)
  assert.ok(!jar.cookies.some((cookie) => cookie.name === 'session'))
  const second = await importer.start(chrome())
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(second.kinds).map(([kind, item]) => [
        kind,
        [item.status, item.imported, item.skippedExisting, item.skippedInvalid],
      ]),
    ),
    {
      cookies: ['ok', 0, 4, 3],
      passwords: ['ok', 0, 2, 1],
    },
  )
  // 没写进新的就不落盘
  assert.equal(jar.flushes(), 1)
})

test('只导某些网站的 Cookie：规范化之后交给读取器，读取器没筛的管线再筛', async (t) => {
  const { importer, calls, jar } = setup(t, {
    fake: {
      // 不听话的读取器：不按域名筛
      data: (input) => {
        const path = join(input.profileDir, 'litch-fake-protected.json')
        return JSON.parse(readFileSync(path, 'utf8'))
      },
    },
  })
  const unfiltered = setup(t, {
    reader: {
      capabilities: defaultFakeCapabilities,
      read: async (input) => {
        const inner = await createFakeReader().read({ ...input, cookieDomains: [] })
        return inner
      },
    },
  })
  const request = chrome({
    kinds: ['cookies'],
    cookieDomains: ['  Example.COM ', 'https://docs.example.org/x', '..', 'not a domain'],
  })
  const outcome = await importer.start(request)
  assert.deepEqual(calls[0]?.cookieDomains, ['example.com', 'docs.example.org'])
  assert.equal(outcome.kinds.cookies?.imported, 3)
  assert.deepEqual(jar.cookies.map((cookie) => cookie.name).sort(), ['prefs', 'session', 'tab'])

  const second = await unfiltered.importer.start(request)
  assert.equal(second.kinds.cookies?.imported, 3)
  // 管线筛掉的不算在发现的条数里
  assert.equal(second.kinds.cookies?.discovered, 5)
  assert.deepEqual(unfiltered.jar.cookies.map((cookie) => cookie.name).sort(), [
    'prefs',
    'session',
    'tab',
  ])
})

test('读取器报的各种状态原样交给界面', async (t) => {
  const { importer } = setup(t)
  const work = await importer.start(chrome({ profileId: 'Profile 1' }))
  assert.equal(work.kinds.cookies?.status, 'locked')
  assert.equal(work.kinds.cookies?.error, 'The Cookies database is in use.')
  assert.equal(work.kinds.passwords?.status, 'ok')

  const edge = await importer.start(chrome({ browser: 'edge' }))
  assert.equal(edge.kinds.cookies?.status, 'denied')
  assert.equal(edge.kinds.passwords?.status, 'denied')

  const firefox = await importer.start(
    chrome({ browser: 'firefox', profileId: 'Profiles/sample.default-release' }),
  )
  assert.equal(firefox.kinds.cookies?.status, 'ok')
  // 读取器读坏了一条：部分成功
  assert.deepEqual(
    [
      firefox.kinds.passwords?.status,
      firefox.kinds.passwords?.imported,
      firefox.kinds.passwords?.failed,
    ],
    ['partial', 1, 1],
  )

  // 资料里什么都没有：Cookie、密码都是 missing
  const vivaldi = await importer.start(chrome({ browser: 'vivaldi' }))
  assert.deepEqual(
    Object.values(vivaldi.kinds).map((item) => item.status),
    ['missing', 'missing'],
  )
})

test('要管理员同意：没勾就是 needs-elevation，勾了才读', async (t) => {
  const { importer, calls } = setup(t, {
    fake: {
      capabilities: (browser) => ({ ...defaultFakeCapabilities(browser), needsElevation: true }),
    },
  })
  const denied = await importer.start(chrome({ kinds: ['cookies'] }))
  assert.equal(denied.kinds.cookies?.status, 'needs-elevation')
  assert.equal(calls[0]?.allowElevated, false)
  const allowed = await importer.start(chrome({ kinds: ['cookies'], allowElevated: true }))
  assert.equal(allowed.kinds.cookies?.status, 'ok')
  assert.equal(calls[1]?.allowElevated, true)
})

/** 这个平台上什么都读不了的读取器 */
const readsNothing: ProtectedReader = {
  capabilities: () => ({ promptsSystemAuth: false, needsElevation: false, kinds: [] }),
  read: async (input) =>
    Object.fromEntries(
      input.kinds.map((kind) => [
        kind,
        { status: 'unsupported', discovered: 0, items: [], failed: 0 },
      ]),
    ),
}

test('读取器读不了、库没接上的类别报 unsupported；来源列表据此报能导的类别', async (t) => {
  const { importer, env } = setup(t, { reader: readsNothing })
  const outcome = await importer.start(chrome())
  assert.equal(outcome.kinds.cookies?.status, 'unsupported')
  assert.equal(outcome.kinds.passwords?.status, 'unsupported')
  assert.deepEqual(importer.sources()[0]?.kinds, [])

  const bare = createImporter({
    env: () => env,
    reader: createFakeReader(),
    cookies: memoryJar(),
    state: createImportStateBook(null),
    now: () => NOW,
  })
  const sources = bare.sources()
  assert.deepEqual(sources[0]?.kinds, ['cookies'])
  const result = await bare.start(chrome())
  assert.equal(result.kinds.cookies?.status, 'ok')
  assert.equal(result.kinds.passwords?.status, 'unsupported')
})

test('来源列表：交给界面的东西里没有路径', async (t) => {
  const { importer, dir } = setup(t)
  const sources = importer.sources()
  assert.deepEqual(
    sources.map((source) => [source.browser, source.name, source.kinds, source.promptsSystemAuth]),
    [
      ['chrome', 'Google Chrome', ['cookies', 'passwords'], process.platform === 'darwin'],
      ['edge', 'Microsoft Edge', ['cookies', 'passwords'], process.platform === 'darwin'],
      ['brave', 'Brave', ['cookies', 'passwords'], process.platform === 'darwin'],
      ['vivaldi', 'Vivaldi', ['cookies', 'passwords'], process.platform === 'darwin'],
      ['firefox', 'Firefox', ['cookies', 'passwords'], false],
    ],
  )
  assert.deepEqual(sources[0]?.profiles[0], {
    id: 'Default',
    name: '个人',
    account: 'sample@example.com',
    isDefault: true,
    has: { cookies: true, passwords: true },
  })
  assert.ok(!JSON.stringify(sources).includes(dir))
})

test('资料已不在、请求不对：整体报 profile-gone', async (t) => {
  const { importer, calls } = setup(t)
  assert.deepEqual(await importer.start(chrome({ profileId: 'Profile 9' })), {
    error: 'profile-gone',
    kinds: {},
  })
  assert.deepEqual(await importer.start(chrome({ browser: 'safari' as never })), {
    error: 'profile-gone',
    kinds: {},
  })
  assert.equal(calls.length, 0)
})

test('一次只一个；读的时候取消：Cookie、密码都 cancelled，再导就不忙了', async (t) => {
  const { importer, jar } = setup(t)
  const brave = chrome({ browser: 'brave' })
  const running = importer.start(brave)
  assert.equal(importer.running(), true)
  assert.deepEqual(await importer.start(chrome()), { error: 'busy', kinds: {} })
  importer.cancel()
  const outcome = await running
  assert.equal(outcome.kinds.cookies?.status, 'cancelled')
  assert.equal(outcome.kinds.passwords?.status, 'cancelled')
  assert.equal(jar.cookies.length, 0)
  assert.equal(importer.running(), false)
  assert.equal((await importer.start(chrome())).kinds.cookies?.status, 'ok')
})

test('写 Cookie 的时候取消：已写的留着并落盘，Cookie cancelled，密码没轮上写是 skipped', async (t) => {
  let importer: ReturnType<typeof setup>['importer'] | null = null
  const jar = memoryJar()
  const set = jar.set
  let count = 0
  jar.set = async (details) => {
    await set(details)
    count += 1
    if (count === 2) importer?.cancel()
  }
  const context = setup(t, { cookies: jar })
  importer = context.importer
  const outcome = await importer.start(chrome())
  assert.equal(outcome.kinds.cookies?.status, 'cancelled')
  assert.equal(outcome.kinds.cookies?.imported, 2)
  assert.equal(jar.flushes(), 1)
  assert.equal(outcome.kinds.passwords?.status, 'skipped')
  assert.equal(outcome.kinds.passwords?.discovered, 3)
  assert.deepEqual(context.passwords.saved, [])
})

test('写不进去的 Cookie 算失败；全失败是 failed；库出错整类 failed', async (t) => {
  const some = setup(t, { cookies: memoryJar([], (details) => details.name === 'prefs') })
  const partial = await some.importer.start(chrome({ kinds: ['cookies'] }))
  assert.deepEqual(
    [partial.kinds.cookies?.status, partial.kinds.cookies?.imported, partial.kinds.cookies?.failed],
    ['partial', 3, 1],
  )
  assert.match(partial.kinds.cookies?.error ?? '', /1 cookie\(s\) were rejected/)

  const none = setup(t, {
    cookies: memoryJar([], () => true),
    passwords: {
      importMany: async () => {
        throw new Error('safeStorage is not available')
      },
    },
  })
  const failed = await none.importer.start(
    chrome({ browser: 'firefox', profileId: 'Profiles/sample.default-release' }),
  )
  // 一条都没写成、也没有别的处理过的：failed
  assert.deepEqual([failed.kinds.cookies?.status, failed.kinds.cookies?.failed], ['failed', 2])
  assert.equal(failed.kinds.passwords?.status, 'failed')
  assert.equal(failed.kinds.passwords?.error, 'safeStorage is not available')
  assert.deepEqual(none.importer.state(), {})
})

test('读取器抛了：这一类 failed，异常不往外传', async (t) => {
  const { importer } = setup(t, {
    reader: {
      capabilities: defaultFakeCapabilities,
      read: async () => {
        throw new Error('secret key 0123456789abcdef')
      },
    },
  })
  const outcome = await importer.start(chrome())
  assert.equal(outcome.kinds.cookies?.status, 'failed')
  assert.equal(outcome.kinds.passwords?.status, 'failed')
  assert.ok(!JSON.stringify(outcome).includes('0123456789abcdef'))
})

test('明文不出现在交给界面的结果和日志里，读取器的话里带了也换掉', async (t) => {
  const leak = 'leaky-cookie-value-123'
  const { importer, logs, jar } = setup(t, {
    cookies: memoryJar([], (details) => details.name === 'prefs'),
    fake: {
      data: () => ({
        cookies: {
          status: 'partial',
          failed: 1,
          error: `could not decrypt next to ${leak}`,
          items: [
            {
              host: 'example.com',
              name: 'a',
              value: leak,
              path: '/',
              secure: true,
              httpOnly: false,
              sameSite: 'lax',
            },
            {
              host: '.example.com',
              name: 'prefs',
              value: 'prefs-secret-value',
              path: '/',
              secure: true,
              httpOnly: false,
              sameSite: 'lax',
            },
          ],
        },
        passwords: {
          error: 'bad entry hunter2-password',
          status: 'partial',
          failed: 1,
          items: [
            {
              origin: 'https://a.example',
              username: 'u',
              password: 'hunter2-password',
              store: 'profile',
            },
          ],
        },
      }),
    },
  })
  const outcome = await importer.start(chrome())
  const text = JSON.stringify(outcome) + logs.join('\n')
  for (const secret of [leak, 'prefs-secret-value', 'hunter2-password']) {
    assert.ok(!text.includes(secret), secret)
  }
  assert.equal(outcome.kinds.cookies?.status, 'partial')
  assert.match(outcome.kinds.cookies?.error ?? '', /^Details withheld\./)
  assert.equal(outcome.kinds.passwords?.error, 'Details withheld.')
  assert.equal(jar.cookies.length, 1)
})

test('导过没有：成功的类别记时间，横幅关掉记时间，都存盘', async (t) => {
  const { importer, userData } = setup(t)
  assert.deepEqual(importer.state(), {})
  // Edge 的 Cookie、密码都被拒：不算导过
  await importer.start(chrome({ browser: 'edge' }))
  assert.deepEqual(importer.state(), {})
  // 工作那份的 Cookie 被占着、密码导进去了：只记密码
  await importer.start(chrome({ profileId: 'Profile 1' }))
  assert.deepEqual(importer.state(), { lastImportAt: NOW })
  importer.dismissBanner()
  const saved = JSON.parse(readFileSync(importStateFile(userData), 'utf8'))
  assert.deepEqual(saved, { version: 1, kinds: { passwords: NOW }, bannerDismissedAt: NOW })
  assert.deepEqual(createImportStateBook(importStateFile(userData)).state(), {
    lastImportAt: NOW,
    bannerDismissedAt: NOW,
  })
})

test('审核 1：只导某些网站却一个都认不出时，Cookie 这一类拒掉，绝不退化成全导；密码照常', async (t) => {
  const { importer, calls, jar } = setup(t)
  const outcome = await importer.start(chrome({ cookieDomains: ['not a domain', '..'] }))
  assert.equal(outcome.kinds.cookies?.status, 'failed')
  assert.equal(outcome.kinds.cookies?.error, 'None of the requested cookie domains is valid.')
  assert.equal(outcome.kinds.passwords?.status, 'ok')
  // 读取器只被要了密码
  assert.deepEqual(calls[0]?.kinds, ['passwords'])
  assert.equal(jar.cookies.length, 0)
  // 只要 Cookie 时读取器根本不被调
  const only = await importer.start(chrome({ kinds: ['cookies'], cookieDomains: [' '] }))
  assert.equal(only.kinds.cookies?.status, 'failed')
  assert.equal(calls.length, 1)
})

test('审核 2：读取器报 partial 但 failed 是 0（库级失败只给了 error），最终也不报 ok', async (t) => {
  const { importer } = setup(t, {
    fake: {
      data: () => ({
        cookies: {
          status: 'partial',
          error: 'The account cookie store could not be read.',
          items: [
            {
              host: 'a.example',
              name: 'x',
              value: 'v1',
              path: '/',
              secure: true,
              httpOnly: false,
              sameSite: 'lax',
            },
          ],
        },
        passwords: { status: 'partial', error: 'Account passwords are unavailable.', items: [] },
      }),
    },
  })
  const outcome = await importer.start(chrome())
  assert.deepEqual(
    [outcome.kinds.cookies?.status, outcome.kinds.cookies?.imported, outcome.kinds.cookies?.failed],
    ['partial', 1, 0],
  )
  assert.equal(outcome.kinds.cookies?.error, 'The account cookie store could not be read.')
  assert.equal(outcome.kinds.passwords?.status, 'partial')
})

test('审核 4：记“导过”写盘失败、Cookie 落盘失败，结果照常返回，错误进 error', async (t) => {
  const jar = memoryJar()
  jar.flush = async () => {
    throw new Error('disk full')
  }
  const book = createImportStateBook(null)
  const { importer } = setup(t, {
    cookies: jar,
    state: {
      ...book,
      imported: () => {
        throw new Error('EACCES')
      },
      dismissBanner: () => {
        throw new Error('EACCES')
      },
    },
  })
  const outcome = await importer.start(chrome())
  assert.equal(outcome.kinds.cookies?.status, 'ok')
  assert.equal(outcome.kinds.cookies?.imported, 4)
  assert.match(outcome.kinds.cookies?.error ?? '', /could not be flushed to disk/)
  assert.match(outcome.kinds.cookies?.error ?? '', /Could not record the import time\.$/)
  assert.equal(outcome.kinds.passwords?.imported, 2)
  assert.equal(outcome.kinds.passwords?.error, 'Could not record the import time.')
  // 关横幅存不下来也不抛
  importer.dismissBanner()
})

test('审核 5：读的时候取消、读取器没理 signal 照常交了结果：两类都是 cancelled，什么都不写', async (t) => {
  let importer: ReturnType<typeof setup>['importer'] | null = null
  const fake = createFakeReader()
  const context = setup(t, {
    reader: {
      capabilities: defaultFakeCapabilities,
      read: async (input) => {
        const result = await fake.read({ ...input, signal: new AbortController().signal })
        importer?.cancel()
        return result
      },
    },
  })
  importer = context.importer
  const outcome = await importer.start(chrome())
  assert.equal(outcome.kinds.cookies?.status, 'cancelled')
  assert.equal(outcome.kinds.passwords?.status, 'cancelled')
  assert.equal(context.jar.cookies.length, 0)
  assert.deepEqual(context.passwords.saved, [])
})

test('审核 6：一条都没进去（导入和已存在都是 0）不记“导过”，横幅照出', async (t) => {
  const { importer } = setup(t, {
    fake: {
      data: () => ({
        cookies: {
          items: [
            {
              host: 'a.example',
              name: 'old',
              value: 'v',
              path: '/',
              secure: true,
              httpOnly: false,
              sameSite: 'lax',
              expires: 1,
            },
          ],
        },
        passwords: { items: [] },
      }),
    },
  })
  const outcome = await importer.start(chrome())
  assert.deepEqual(
    [outcome.kinds.cookies?.status, outcome.kinds.cookies?.skippedInvalid],
    ['ok', 1],
  )
  assert.equal(outcome.kinds.passwords?.status, 'ok')
  assert.deepEqual(importer.state(), {})
})

test('审核 7：读取器交来的不合约时按那一类 failed 或逐条无效，不整体崩', async (t) => {
  const shapes: unknown[] = [
    { cookies: { status: 'ok', items: 'nope' }, passwords: 'nope' },
    { cookies: { status: 'weird', items: [] }, passwords: { status: 'ok' } },
    null,
  ]
  for (const shape of shapes) {
    const { importer } = setup(t, {
      reader: { capabilities: defaultFakeCapabilities, read: async () => shape as never },
    })
    const outcome = await importer.start(chrome())
    assert.equal(outcome.kinds.cookies?.status, 'failed', JSON.stringify(shape))
    assert.equal(outcome.kinds.passwords?.status, 'failed', JSON.stringify(shape))
  }
  // 条目里有坏的：只算那几条无效，好的照导；数字不对的按条目补
  const { importer, jar, passwords } = setup(t, {
    reader: {
      capabilities: defaultFakeCapabilities,
      read: async () =>
        ({
          cookies: {
            status: 'ok',
            discovered: 'many',
            failed: -3,
            items: [
              null,
              { host: 5, name: 'a', value: 'b' },
              {
                host: 'ok.example',
                name: 'a',
                value: 'b',
                path: '/',
                secure: true,
                httpOnly: false,
                sameSite: 'lax',
              },
            ],
          },
          passwords: {
            status: 'ok',
            items: [
              null,
              { origin: 5 },
              {
                origin: 'https://ok.example',
                username: 'u',
                password: 'p4ss-word',
                store: 'profile',
              },
            ],
          },
        }) as never,
    },
  })
  const outcome = await importer.start(chrome({ cookieDomains: ['ok.example'] }))
  assert.deepEqual(
    [
      outcome.kinds.cookies?.status,
      outcome.kinds.cookies?.discovered,
      outcome.kinds.cookies?.imported,
      outcome.kinds.cookies?.skippedInvalid,
    ],
    ['ok', 3, 1, 2],
  )
  assert.deepEqual(
    [
      outcome.kinds.passwords?.status,
      outcome.kinds.passwords?.imported,
      outcome.kinds.passwords?.skippedInvalid,
    ],
    ['ok', 1, 2],
  )
  assert.equal(jar.cookies.length, 1)
  assert.equal(passwords.saved.length, 1)
})
