import type { ProtectedReader } from '../protected-types.mjs'
import type { SystemSecrets } from './chromium-crypto.mjs'
import { readerForPlatform } from './reader.mjs'

export function createProtectedReader(options: {
  platform: NodeJS.Platform
  secrets: SystemSecrets
}): ProtectedReader {
  return readerForPlatform(options.platform, options.secrets)
}
