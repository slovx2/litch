import type { HarnessView } from '@litch/core'
import { nextStep } from '../../../../../packages/ui/src/app/device.ts'
import type { Translator } from '../../../../../packages/ui/src/i18n/index.ts'

// 断网与运行时故障的区分和桌面共用，不维护第二份判断。
export { downHarness } from '../../../../../packages/ui/src/app/device.ts'

/** 原因和处理办法始终随当前状态显示，不能只让用户无限等待恢复。 */
export function harnessNotice(down: HarnessView, t: Translator): string {
  const title = t(down.state === 'disabled' ? 'harness.off' : 'harness.down', { name: down.name })
  const reason = down.reason ? t.text(down.reason) : null
  return `${reason ? `${title} · ${reason}` : title}\n${nextStep(down, t)}`
}
