// litch_machine 的执行器（08 号设计 2.3、2.4、3.3；接口见 types.mts）。
// 基线里只是个占位：每次调用都回“还没做好”。甲线把它换成真的实现，接线那边（乙线）只调 createMachineExecutor。
import { clientToolFailure } from '../../../../protocol/src/client-tools.mjs'
import type { Clock } from '../../channel/protocol.mjs'
import type { MachineExecutor } from './types.mjs'

export interface MachineExecutorOptions {
  clock: Clock
  log?(line: string): void
}

export function createMachineExecutor(_options: MachineExecutorOptions): MachineExecutor {
  return {
    async call() {
      return clientToolFailure('failed', 'Litch cannot run machine tools yet.')
    },
    processes: () => [],
    onProcessesChanged: () => () => {},
    kill: () => false,
    stopAll() {},
    ownerPresence() {},
    dispose() {},
  }
}
