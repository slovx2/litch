// 读取器的桩：这个目录归用户，真正的实现替换这一份。接口见 ../protected-types.mts。
// 桩什么都读不了：capabilities 报空的 kinds，read 对要的每一类都回 unsupported。
import type {
  ProtectedKindResult,
  ProtectedReader,
  ProtectedReadResult,
} from '../protected-types.mjs'

const unsupported = <T,>(): ProtectedKindResult<T> => ({
  status: 'unsupported',
  discovered: 0,
  items: [],
  failed: 0,
  error: 'Reading protected browser data is not available in this build.',
})

export function createProtectedReader(): ProtectedReader {
  return {
    capabilities: () => ({ promptsSystemAuth: false, needsElevation: false, kinds: [] }),
    async read(input) {
      const result: ProtectedReadResult = {}
      if (input.kinds.includes('cookies')) result.cookies = unsupported()
      if (input.kinds.includes('passwords')) result.passwords = unsupported()
      return result
    },
  }
}
