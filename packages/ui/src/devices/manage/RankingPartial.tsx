// 排序页里“有几个 harness 的模型没读到”那一块：不当成报错，逐个说清是哪个、为什么、去哪里处理。
// 没装、停用、不可用照设备对这个 harness 的说法；可用却读不到的多半是没登录，设备的原话放在提示里。
import type { DeviceView } from '@litch/core'
import { useT } from '../../app/appearance.ts'
import { badgeOf, nameOf } from '../../app/device.ts'
import { Icon } from '../../app/icons.tsx'
import { listOf, readFailureOf } from './ranking-view.ts'

export function RankingPartial({
  device,
  errors,
  busy,
  onReload,
  onSettings,
}: {
  device: DeviceView
  errors: Record<string, string>
  busy: boolean
  onReload(): void
  onSettings: ((harnessId: string) => void) | null
}) {
  const t = useT()
  const failed = Object.keys(errors)
  if (failed.length === 0) return null
  return (
    <div className="rk-partial" role="note" data-ranking-partial>
      <Icon name="info" small />
      <div className="rk-partial-body">
        <b>
          {t('ranking.partial.title', {
            harnesses: listOf(
              failed.map((id) => nameOf(device, id, t)),
              t.lang,
            ),
          })}
        </b>
        <ul>
          {failed.map((id) => {
            const harness = device.harnesses.find((entry) => entry.id === id)
            const kind = readFailureOf(id, device.harnesses)
            const reason =
              kind === 'unavailable' && harness?.reason
                ? t.text(harness.reason)
                : t(`ranking.partial.${kind}`)
            return (
              <li key={id} data-harness={id} data-reason={kind}>
                <span className="chip">{badgeOf(device, id)}</span>
                <span className="rk-partial-name">{nameOf(device, id, t)}</span>
                <span className="rk-partial-why" title={errors[id]}>
                  {reason}
                </span>
                {harness && onSettings ? (
                  <button
                    type="button"
                    className="mini"
                    data-act="ranking-harness-settings"
                    onClick={() => onSettings(id)}
                  >
                    {t('ranking.partial.settings')}
                  </button>
                ) : null}
              </li>
            )
          })}
        </ul>
        <span className="mng-sec-note">{t('ranking.partial.note')}</span>
      </div>
      <button
        type="button"
        className="mini"
        data-act="ranking-partial-reload"
        disabled={busy}
        onClick={onReload}
      >
        {t('ranking.refresh')}
      </button>
    </div>
  )
}
