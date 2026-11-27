// Litch 宿主入口；实现由通用 CU 包提供。
import {
  clientToolFailure,
  UNATTENDED_COMPUTER_SELF,
} from '../../../../packages/protocol/src/client-tools.mjs'
import {
  type ComputerExecutorOptions,
  createComputerExecutor as createSharedExecutor,
} from '../../../../third_party/litch-automation/packages/computer-use/src/executor.mjs'

export * from '../../../../third_party/litch-automation/packages/computer-use/src/executor.mjs'

export function createComputerExecutor(options: ComputerExecutorOptions) {
  const executor = createSharedExecutor(options)
  return {
    ...executor,
    async call(...args: Parameters<typeof executor.call>) {
      const reply = await executor.call(...args)
      const first = reply.contentItems[0]
      return first?.type === 'inputText' &&
        first.text === `[litch:failed] ${UNATTENDED_COMPUTER_SELF}`
        ? clientToolFailure('unattended', UNATTENDED_COMPUTER_SELF)
        : reply
    },
  }
}
