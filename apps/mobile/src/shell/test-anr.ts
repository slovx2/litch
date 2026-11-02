import { requireNativeModule } from 'expo-modules-core'
import type { BootMode } from './boot'

/** 只认当前核心的实际模式，不能从深链参数伪造模式来阻塞正式连接。 */
export function injectTestAnr(mode: BootMode): void {
  if (mode !== 'mock' && mode !== 'fixture') return
  requireNativeModule<{ blockMainThread(mode: string): void }>('LitchTestControl').blockMainThread(
    mode,
  )
}
