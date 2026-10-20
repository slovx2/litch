import type {
  ProtectedKind,
  ProtectedReader,
  ProtectedReadResult,
  ProtectedStatus,
} from '../protected-types.mjs'
import type { BrowserId } from '../types.mjs'
import { chromiumCookies, chromiumPasswords } from './chromium.mjs'
import { ChromiumCrypto, type SystemSecrets, systemSecrets } from './chromium-crypto.mjs'
import { firefoxCookies, firefoxPasswords } from './firefox.mjs'
import { checkCancelled, failure, faultStatus, ReadFault } from './result.mjs'
import { Snapshot, validateDirectories } from './snapshot.mjs'

const BROWSERS = new Set<BrowserId>([
  'chrome',
  'edge',
  'brave',
  'arc',
  'chromium',
  'vivaldi',
  'firefox',
])

// 依赖注入仅供本目录单测，产品入口不暴露替换平台、密钥或快照的选项。
export function readerForPlatform(
  platform: NodeJS.Platform,
  secrets: SystemSecrets = systemSecrets(),
): ProtectedReader {
  return {
    capabilities(browser) {
      const supported = (platform === 'darwin' || platform === 'win32') && BROWSERS.has(browser)
      return {
        kinds: supported ? ['cookies', 'passwords'] : [],
        promptsSystemAuth: supported && platform === 'darwin' && browser !== 'firefox',
        // 能力接口不能看资料；保守提示 Chromium 可能遇到应用绑定记录。
        needsElevation: supported && platform === 'win32' && browser !== 'firefox',
      }
    },
    async read(input) {
      const result: ProtectedReadResult = {}
      let snapshot: Snapshot | undefined
      let crypto: ChromiumCrypto | undefined
      const kinds: ProtectedKind[] = [...new Set(input.kinds)].filter(
        (kind) => kind === 'cookies' || kind === 'passwords',
      )
      function failAll(status: ProtectedStatus): void {
        for (const kind of kinds) {
          const previous = result[kind]
          result[kind] = {
            ...failure<never>(status),
            discovered: previous?.discovered ?? 0,
            failed: previous?.failed ?? 0,
          }
        }
      }
      try {
        checkCancelled(input.signal)
        if (!kinds.length) return result
        if ((platform !== 'darwin' && platform !== 'win32') || !BROWSERS.has(input.browser))
          throw new ReadFault('unsupported')
        if ((input.browser === 'firefox') !== (input.family === 'firefox'))
          throw new ReadFault('failed')
        await validateDirectories(input.root, input.profileDir)
        snapshot = await Snapshot.create(input.signal)
        crypto = new ChromiumCrypto(platform, input, snapshot, secrets)
        for (const kind of kinds) {
          checkCancelled(input.signal)
          if (kind === 'cookies')
            result.cookies =
              input.family === 'firefox'
                ? await firefoxCookies(input, snapshot)
                : await chromiumCookies(input, snapshot, crypto)
          else
            result.passwords =
              input.family === 'firefox'
                ? await firefoxPasswords(input, snapshot)
                : await chromiumPasswords(input, snapshot, crypto)
        }
        checkCancelled(input.signal)
      } catch (error) {
        failAll(faultStatus(error))
      } finally {
        crypto?.dispose()
        try {
          await snapshot?.dispose()
        } catch {
          failAll('failed')
        }
      }
      return result
    },
  }
}
