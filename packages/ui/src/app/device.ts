// 和设备、harness 有关的几个显示用小函数
import type { DeviceView, HarnessView } from '@litch/core'
import type { CSSProperties } from 'react'
import type { MessageKey, Translator } from '../i18n/index.ts'

/** 把设备的线色交给样式：这个元素和它里面的内容都用这根线色 */
export const wireStyle = (wire: string | undefined): CSSProperties =>
  ({ '--wire': `var(--wire-${wire ?? 'slate'})` }) as CSSProperties

/** harness 的两字母徽标。设备没声明这个 harness 时取标识的前两个字母 */
export function badgeOf(device: DeviceView | undefined, harnessId: string): string {
  const harness = device?.harnesses.find((entry) => entry.id === harnessId)
  return harness?.badge ?? harnessId.slice(0, 2).toUpperCase()
}

export function nameOf(device: DeviceView | undefined, harnessId: string): string {
  return device?.harnesses.find((entry) => entry.id === harnessId)?.name ?? harnessId
}

/**
 * 这个 harness 现在是不是用不了。设备连着、它声明了这个 harness、而且它不是可用的，才算：
 * 设备没连上是另一回事（整台设备都够不着），由设备的连接状态去说。用不了就给出它，可用给 null
 */
export function downHarness(
  device: DeviceView | undefined,
  harnessId: string | undefined,
): HarnessView | null {
  if (device?.connection !== 'online' || !harnessId) return null
  const harness = device.harnesses.find((entry) => entry.id === harnessId)
  return harness && harness.state !== 'ready' ? harness : null
}

const DOWN_TEXT = {
  /** 徽标上的提示 */
  chip: ['harness.down', 'harness.off'],
  /** 输入区：为什么发不了 */
  composer: ['composer.harnessDown', 'composer.harnessOff'],
  /** 对话区：为什么内容读不出来 */
  transcript: ['transcript.harnessDown', 'transcript.harnessOff'],
} as const

/**
 * 一个 harness 用不了，对人怎么说。一时用不了的说“等它恢复”；
 * 在设置里停用了的不会自己恢复，要说去哪儿把它重新启用
 */
export function downText(down: HarnessView, where: keyof typeof DOWN_TEXT, t: Translator): string {
  return t(DOWN_TEXT[where][down.state === 'disabled' ? 1 : 0], { name: down.name })
}

/** 认识的几种不可用，各自的下一步怎么说。种类是设备服务给的，以后会加新的 */
const NEXT_STEP: Record<string, MessageKey> = {
  connecting: 'harness.next.connecting',
  unreachable: 'harness.next.unreachable',
  handshakeFailed: 'harness.next.handshakeFailed',
  disconnected: 'harness.next.disconnected',
  starting: 'harness.next.starting',
  disabled: 'harness.next.disabled',
  notInstalled: 'harness.next.notInstalled',
  versionTooLow: 'harness.next.versionTooLow',
  startFailed: 'harness.next.startFailed',
  stopped: 'harness.next.stopped',
}

/**
 * 一个 harness 用不了之后，人该做什么。按设备给的种类用界面自己的话说（两种语言都有）；
 * 这一版不认识的种类给一般的说法，设备的原话另外作为细节显示
 */
export function nextStep(down: HarnessView, t: Translator): string {
  const known = NEXT_STEP[down.down ?? '']
  if (known) return t(known)
  return t(down.state === 'disabled' ? 'harness.next.disabled' : 'harness.next.other')
}

/** 徽标上的提示：平时是 harness 的名字；它用不了的时候说它用不了 */
export function chipTitle(
  device: DeviceView | undefined,
  harnessId: string,
  t: Translator,
): string {
  const down = downHarness(device, harnessId)
  return down ? downText(down, 'chip', t) : nameOf(device, harnessId)
}

/** 这台设备是怎么连上的，一句话 */
export function viaOf(device: DeviceView, t: Translator): string {
  if (device.target === null) return t('devices.via.local')
  return device.target.kind === 'alias'
    ? t('devices.via.alias', { alias: device.target.alias })
    : t('devices.via.host', { host: device.host })
}
