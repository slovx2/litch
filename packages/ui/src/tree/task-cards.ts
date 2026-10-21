// 提案卡右上角菜单里的“在 {设备} 上对 {harness} 关闭任务卡”：直接写设备设置 harness.<id>.taskCards
//（task-cards-write.ts），底部出一条“已关闭 · 撤销 · 去设置”的提示。
import type { CoreChannel, DeviceView, Replica } from '@litch/core'
import { requestSettings } from '../app/actions.ts'
import { nameOf } from '../app/device.ts'
import { whyNot } from '../app/errors.ts'
import { dismissToast, showToast } from '../app/toasts.tsx'
import { TaskCardsMissing, writeTaskCards } from './task-cards-write.ts'

/** 菜单里点了“关闭任务卡”：关掉，出可撤销的提示；没关成出红字提示 */
export function turnOffTaskCards(
  channel: CoreChannel,
  replica: Replica,
  device: DeviceView,
  harness: string,
): Promise<void> {
  const id = `task-cards:${device.id}:${harness}`
  const name = nameOf(device, harness)
  const failed = (error: unknown) =>
    showToast({
      id,
      tone: 'err',
      text: (t) =>
        error instanceof TaskCardsMissing
          ? t('proposal.cardsOff.missing')
          : t('proposal.cardsOff.failed', { reason: whyNot(error, t) }),
      lifeMs: 6000,
    })
  return writeTaskCards(channel, replica, device.id, harness, false).then(
    () =>
      showToast({
        id,
        text: (t) => t('proposal.cardsOff.done', { harness: name }),
        action: {
          label: (t) => t('proposal.cardsOff.undo'),
          run: () => {
            writeTaskCards(channel, replica, device.id, harness, true).then(
              () => dismissToast(id),
              failed,
            )
          },
        },
        more: {
          label: (t) => t('proposal.cardsOff.settings'),
          run: () => {
            dismissToast(id)
            requestSettings('switches')
          },
        },
        lifeMs: 9000,
      }),
    failed,
  )
}
