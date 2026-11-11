// 经理设置里选“工作线模型”时的即时提示：高于经理自己的模型（或有一方未分级）时当场说出来，
// 给“调整模型等级”的入口。只是提示，不拦保存；真正派线时设备还会再校验。
import {
  type DeviceView,
  keys,
  type ModelRankingSnapshot,
  modelLimitPreview,
  rankedModelSelection,
} from '@litch/core'
import { useEffect, useState } from 'react'
import { requestDevice } from '../app/actions.ts'
import { useT } from '../app/appearance.ts'
import { useKey, useServices } from '../app/services.tsx'

export function ManagerLimitHint({
  device,
  sessionId,
  harness,
  model,
  lineHarness,
  lineModel,
}: {
  device: DeviceView | undefined
  /** 经理会话；新建经理时还没有 */
  sessionId: string
  harness: string
  model: string | null
  lineHarness: string
  lineModel: string | null
}) {
  const t = useT()
  const { channel } = useServices()
  const deviceId = device?.id ?? ''
  const shared = useKey<ModelRankingSnapshot>(keys.modelRanking(deviceId))
  const [read, setRead] = useState<ModelRankingSnapshot | null>(null)
  const ranking = shared ?? read
  // 副本里还没有排序快照（设备页没打开过）：自己读一次
  useEffect(() => {
    if (shared || !device?.modelRanking || device.connection !== 'online') return
    let live = true
    channel
      .command('device.modelRanking.read', { deviceId })
      .then((value) => {
        if (live) setRead(value)
      })
      .catch(() => {})
    return () => {
      live = false
    }
  }, [channel, deviceId, shared, device?.modelRanking, device?.connection])
  if (!ranking || !model || !lineModel) return null
  const preview = modelLimitPreview(
    ranking,
    rankedModelSelection(ranking, harness, model),
    rankedModelSelection(ranking, lineHarness, lineModel),
    { deviceId, sessionId },
  )
  if (preview.allowed || !preview.failure) return null
  return (
    <div className="form-note limit-hint" role="status" data-manager-limit>
      <span>{t.text(preview.failure.text)}</span>
      <button type="button" className="mini" onClick={() => requestDevice(deviceId, 'ranking')}>
        {t('limit.ranking')}
      </button>
    </div>
  )
}
