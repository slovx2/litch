// 设备详情里“无人值守”一行：状态摘要和进入无人值守页的按钮。设备服务不支持（没有 litchExternalSources）不出这一节。
import type { DeviceView } from '@litch/core'
import { useT } from '../app/appearance.ts'
import { Forward } from '../app/icons.tsx'
import { useExternalDevice } from './data.ts'
import { sourcesSummary } from './model.ts'
import { Dot } from './parts.tsx'

export function UnattendedSection({ device, onOpen }: { device: DeviceView; onOpen(): void }) {
  const t = useT()
  const view = useExternalDevice(device.id, device.externalSources === true)
  if (!device.externalSources) return null
  const sources = view?.sources.value ?? null
  const autostart = view?.autostart.value ?? null
  const sum = sources ? sourcesSummary(sources) : null
  const tone = !sum?.total
    ? 'off'
    : sum.counts.blocked
      ? 'err'
      : sum.counts.backoff
        ? 'wait'
        : sum.counts.collecting
          ? 'ok'
          : 'off'
  const parts: string[] = []
  if (sum?.total) {
    if (sum.counts.collecting) parts.push(t('ext.sum.collecting', { n: sum.counts.collecting }))
    if (sum.counts.paused) parts.push(t('ext.sum.paused', { n: sum.counts.paused }))
    if (sum.counts.backoff) parts.push(t('ext.sum.backoff', { n: sum.counts.backoff }))
    if (sum.counts.blocked) parts.push(t('ext.sum.blocked', { n: sum.counts.blocked }))
    if (sum.pending) parts.push(t('ext.sum.pending', { n: sum.pending }))
  } else if (sum) parts.push(t('ext.sum.none'))
  if (autostart && autostart.state !== 'unsupported')
    parts.push(t(autostart.state === 'enabled' ? 'ext.sum.autostartOn' : 'ext.sum.autostartOff'))
  return (
    <section className="mng-sec" data-sec="unattended">
      <div className="mng-sec-head">
        <h2>{t('ext.title')}</h2>
        {sum ? <Dot tone={tone} label={parts.join(' · ')} /> : null}
        <span className="mng-sum ell" data-ext-summary>
          {parts.join(' · ')}
        </span>
        <span className="grow" />
        <button
          type="button"
          className="ibtn"
          data-act="unattended-open"
          title={t('ext.openPage')}
          aria-label={t('ext.openPage')}
          onClick={onOpen}
        >
          <Forward />
        </button>
      </div>
    </section>
  )
}
