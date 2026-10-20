// 假读取器：管线、界面的测试和样本模式（LITCH_BROWSER_IMPORT_FAKE）用，不碰任何真实浏览器的资料。
// 每份资料要读到什么，写在资料目录里的 litch-fake-protected.json（FakeProfileData），样本见 sample.mts。
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type {
  ImportedCookie,
  ImportedPassword,
  ProtectedCapabilities,
  ProtectedKindResult,
  ProtectedReader,
  ProtectedReadInput,
  ProtectedReadResult,
} from '../protected-types.mjs'
import type { BrowserId } from '../types.mjs'

export const FAKE_PROTECTED_FILE = 'litch-fake-protected.json'

/** 一类数据假装读到什么：status 默认 ok，discovered 默认 items 加 failed */
export interface FakeKind<T> {
  status?: ProtectedKindResult<T>['status']
  items?: T[]
  failed?: number
  discovered?: number
  error?: string
}

export interface FakeProfileData {
  cookies?: FakeKind<ImportedCookie>
  passwords?: FakeKind<ImportedPassword>
  /** 读之前等这么久（毫秒），给取消用 */
  delayMs?: number
}

export interface FakeReaderOptions {
  capabilities?: (browser: BrowserId) => ProtectedCapabilities
  /** 默认读资料目录里的 litch-fake-protected.json，没有就当这份资料里什么都没有 */
  data?: (input: ProtectedReadInput) => FakeProfileData | null
  /** 每次 read 的参数记在这里（测试看交给读取器的是什么） */
  calls?: ProtectedReadInput[]
}

/** 默认：两类都能读；Mac 上 Chromium 系要弹钥匙串；Windows 上 Chrome 要管理员同意 */
export const defaultFakeCapabilities = (browser: BrowserId): ProtectedCapabilities => ({
  promptsSystemAuth: process.platform === 'darwin' && browser !== 'firefox',
  needsElevation: process.platform === 'win32' && browser === 'chrome',
  kinds: ['cookies', 'passwords'],
})

const readFile = (input: ProtectedReadInput): FakeProfileData | null => {
  try {
    return JSON.parse(readFileSync(join(input.profileDir, FAKE_PROTECTED_FILE), 'utf8'))
  } catch {
    return null
  }
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve()
    const timer = setTimeout(resolve, ms)
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        resolve()
      },
      { once: true },
    )
  })

const empty = <T,>(status: ProtectedKindResult<T>['status']): ProtectedKindResult<T> => ({
  status,
  discovered: 0,
  items: [],
  failed: 0,
})

function shape<T>(fake: FakeKind<T> | undefined): ProtectedKindResult<T> {
  if (!fake) return empty('missing')
  const items = [...(fake.items ?? [])]
  const failed = fake.failed ?? 0
  const status = fake.status ?? 'ok'
  const result: ProtectedKindResult<T> = {
    status,
    discovered: fake.discovered ?? items.length + failed,
    // 没读成的那几种状态不交条目
    items: status === 'ok' || status === 'partial' ? items : [],
    failed,
  }
  if (fake.error) result.error = fake.error
  return result
}

const matches = (host: string, domains: string[]) => {
  const bare = host.replace(/^\./, '').toLowerCase()
  return domains.some((domain) => bare === domain || bare.endsWith(`.${domain}`))
}

export function createFakeReader(options: FakeReaderOptions = {}): ProtectedReader {
  const capabilities = options.capabilities ?? defaultFakeCapabilities
  const data = options.data ?? readFile
  return {
    capabilities,
    async read(input) {
      options.calls?.push(input)
      const caps = capabilities(input.browser)
      const all = (status: ProtectedKindResult<never>['status']) => {
        const out: ProtectedReadResult = {}
        if (input.kinds.includes('cookies')) out.cookies = empty(status)
        if (input.kinds.includes('passwords')) out.passwords = empty(status)
        return out
      }
      if (caps.needsElevation && !input.allowElevated) return all('needs-elevation')
      const fake = data(input)
      if (fake?.delayMs) await sleep(fake.delayMs, input.signal)
      if (input.signal.aborted) return all('cancelled')
      const out: ProtectedReadResult = {}
      if (input.kinds.includes('cookies')) {
        const cookies = shape(caps.kinds.includes('cookies') ? fake?.cookies : undefined)
        if (!caps.kinds.includes('cookies')) cookies.status = 'unsupported'
        if (input.cookieDomains?.length) {
          const domains = input.cookieDomains
          cookies.items = cookies.items.filter((item) => matches(item.host, domains))
          cookies.discovered = cookies.items.length + cookies.failed
        }
        out.cookies = cookies
      }
      if (input.kinds.includes('passwords')) {
        const passwords = shape(caps.kinds.includes('passwords') ? fake?.passwords : undefined)
        if (!caps.kinds.includes('passwords')) passwords.status = 'unsupported'
        out.passwords = passwords
      }
      return out
    },
  }
}
