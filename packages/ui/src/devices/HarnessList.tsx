// 一台设备上有哪些 harness、各自能不能用。设备页和侧栏的设备信息卡共用这一份。
import type { DeviceView, HarnessView } from '@litch/core'
import { useT } from '../app/appearance.ts'
import { nextStep } from '../app/device.ts'

const STATE_CLASS: Record<Exclude<HarnessView['state'], 'ready'>, string> = {
  // 设备服务会自己接着试，所以按“在等”的样子画，不按出错画
  unavailable: 'pill wait',
  disabled: 'pill mute',
}

/**
 * 一个 harness 为什么用不了、接下来怎么办。原因和下一步是界面按种类自己说的（跟着界面的语言）；
 * 设备的原话排在后面，画得淡一些，给想细看的人。可用的不显示
 */
export function HarnessWhy({ harness }: { harness: HarnessView }) {
  const t = useT()
  if (harness.state === 'ready') return null
  return (
    <span className="harness-why" data-down={harness.down ?? ''}>
      <span className="harness-reason">
        {harness.reason ? t.text(harness.reason) : t(`harness.state.${harness.state}`)}
      </span>
      <span className="harness-next">{nextStep(harness, t)}</span>
      {harness.detail ? (
        <span className="harness-said mono" title={t('harness.said')}>
          {t.said(harness.detail)}
        </span>
      ) : null}
    </span>
  )
}

/**
 * harness 一个一项：徽标、名字、版本。用不了的那一项多一个状态小标，下面说原因和下一步。
 * 侧栏里还留着它的会话的，再说一句那些会话现在是怎么回事：
 * 侧栏的设备行上只有一个记号，话都在这里说。
 */
export function HarnessList({ device }: { device: DeviceView }) {
  const t = useT()
  if (device.harnesses.length === 0) return t('devices.harness.unknown')
  return device.harnesses.map((harness) => {
    const ready = harness.state === 'ready'
    return (
      <span
        key={harness.id}
        className={ready ? 'harness-entry' : 'harness-entry down'}
        data-harness={harness.id}
        data-state={harness.state}
      >
        <span className={ready ? 'chip' : 'chip off'}>{harness.badge}</span>
        {harness.name}
        {harness.version ? <span className="mono dim">{harness.version}</span> : null}
        {harness.state === 'ready' ? null : (
          <span className={STATE_CLASS[harness.state]}>{t(`harness.state.${harness.state}`)}</span>
        )}
        <HarnessWhy harness={harness} />
        {!ready && device.stranded.includes(harness.id) ? (
          <span className="harness-left" data-stranded>
            {t(harness.state === 'disabled' ? 'harness.stranded.off' : 'harness.stranded.down')}
          </span>
        ) : null}
      </span>
    )
  })
}
