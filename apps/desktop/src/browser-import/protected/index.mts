import type { ProtectedReader } from '../protected-types.mjs'
import { readerForPlatform } from './reader.mjs'

export function createProtectedReader(): ProtectedReader {
  return readerForPlatform(process.platform)
}
