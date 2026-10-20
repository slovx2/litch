import { readerForPlatform } from './reader.mjs'
import type { ProtectedReader } from '../protected-types.mjs'

export function createProtectedReader(): ProtectedReader {
  return readerForPlatform(process.platform)
}
