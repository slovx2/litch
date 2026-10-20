// 一台设备上有哪些 harness、各自能不能用。设备页和侧栏的设备信息卡共用这一份。
import type { DeviceView, HarnessView } from '@litch/core'
import type { ReactNode } from 'react'
import { useT } from '../app/appearance.ts'
import { nextStep } from '../app/device.ts'

/**
 * 一个 harness 为什么用不了、接下来怎么办。原因和下一步是界面按种类自己说的（跟着界面的语言）；
 * 设备的原话排在后面，画得淡一些，给想细看的人。可用的不显示。
 * brief：信息卡里只说原因和下一步，设备的原话放进原因的悬停提示，完整的在设备页
 */
export function HarnessWhy({ harness, brief = false }: { harness: HarnessView; brief?: boolean }) {
  const t = useT()
  if (harness.state === 'ready') return null
  // 停用了的是用户自己关的：一个“已停用”加一句去哪儿打开，设备的原因和原话都是同一个意思，不再重复
  if (harness.state === 'disabled') {
    return (
      <span className="harness-why" data-down={harness.down ?? ''}>
        <span className="harness-reason">{t('harness.state.disabled')}</span>
        <span className="harness-next">{nextStep(harness, t)}</span>
      </span>
    )
  }
  const said = harness.detail ? t.said(harness.detail) : null
  return (
    <span className="harness-why" data-down={harness.down ?? ''}>
      <span className="harness-reason" title={brief && said ? said : undefined}>
        {harness.reason ? t.text(harness.reason) : t(`harness.state.${harness.state}`)}
      </span>
      <span className="harness-next">{nextStep(harness, t)}</span>
      {said && !brief ? (
        <span className="harness-said mono" title={t('harness.said')}>
          {said}
        </span>
      ) : null}
    </span>
  )
}

/** 一个 harness 的徽标、名字、版本 */
function Entry({ harness, children }: { harness: HarnessView; children?: ReactNode }) {
  const ready = harness.state === 'ready'
  return (
    <span
      className={
        ready ? 'harness-entry' : `harness-entry ${harness.state === 'disabled' ? 'off' : 'down'}`
      }
      data-harness={harness.id}
      data-state={harness.state}
    >
      <span className={ready ? 'chip' : 'chip off'}>{harness.badge}</span>
      {harness.name}
      {harness.version ? <span className="mono dim">{harness.version}</span> : null}
      {children}
    </span>
  )
}

/**
 * 设备上的 harness 分三拨：能用的排在前面连成一片；用不了的（设备会自己再试）各占一行，说原因和下一步；
 * 停用了的是用户自己关的，不逐个解释，收成最后淡淡的一行，怎么重新启用放在提示里。
 * 侧栏里还留着它的会话的，再说一句那些会话现在是怎么回事：侧栏的设备行上只有一个记号，话都在这里说。
 * brief 见 HarnessWhy
 */
export function HarnessList({ device, brief = false }: { device: DeviceView; brief?: boolean }) {
  const t = useT()
  if (device.harnesses.length === 0) return t('devices.harness.unknown')
  const ready = device.harnesses.filter((harness) => harness.state === 'ready')
  const down = device.harnesses.filter((harness) => harness.state === 'unavailable')
  const off = device.harnesses.filter((harness) => harness.state === 'disabled')
  const strandedOff = off.some((harness) => device.stranded.includes(harness.id))
  return (
    <>
      {ready.map((harness) => (
        <Entry key={harness.id} harness={harness} />
      ))}
      {down.map((harness) => (
        <Entry key={harness.id} harness={harness}>
          {/* 设备服务会自己接着试，所以按“在等”的样子画，不按出错画 */}
          <span className="pill wait">{t('harness.state.unavailable')}</span>
          <HarnessWhy harness={harness} brief={brief} />
          {device.stranded.includes(harness.id) ? (
            <span className="harness-left" data-stranded>
              {t('harness.stranded.down')}
            </span>
          ) : null}
        </Entry>
      ))}
      {off.length > 0 ? (
        <span className="harness-off" title={t('harness.next.disabled')}>
          <span className="harness-off-label">{t('harness.state.disabled')}</span>
          {off.map((harness) => (
            <Entry key={harness.id} harness={harness} />
          ))}
          {strandedOff ? (
            <span className="harness-left" data-stranded>
              {t('harness.stranded.off')}
            </span>
          ) : null}
        </span>
      ) : null}
    </>
  )
}
