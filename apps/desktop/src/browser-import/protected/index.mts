import { readerForPlatform } from './reader.mjs'
import type { ProtectedReader } from './types.mjs'

export function createProtectedReader(): ProtectedReader {
  return readerForPlatform(process.platform)
}
