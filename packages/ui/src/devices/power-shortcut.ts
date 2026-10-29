import type { DevicePowerView } from '@litch/core'
import type { Translator } from '../i18n/index.ts'

export const PLUGGED_POWER_SETTING = 'power.keepAwakeWhilePluggedIn'

/** 描述配置和当前供电，电池上启用开关不冒充已经申请断言。 */
export function powerShortcutTitle(
  power: DevicePowerView,
  enabled: boolean,
  online: boolean,
  t: Translator,
): string {
  return [
    t('power.quick.name'),
    t(enabled ? 'power.quick.on' : 'power.quick.off'),
    online ? t(`power.source.${power.powerSource}`) : t('manage.offline'),
    enabled && online && power.powerSource !== 'ac' ? t('power.quick.wait') : null,
    online ? t.said(power.text) : null,
    t('power.quick.energy'),
  ]
    .filter(Boolean)
    .join('\n')
}

/**
 * 电源设置的状态行：服务给的申请状态；开了接电常开、正用电池、又没有别的来源在阻止休眠时，
 * 服务只说“未阻止”，这里写成“正在使用电池 · 接通电源后生效”，说清楚开关为什么还没起作用
 */
export function powerStatusLine(power: DevicePowerView, plugged: boolean, t: Translator): string {
  if (power.state === 'inactive' && plugged && power.powerSource === 'battery')
    return `${t('power.source.battery')} · ${t('power.quick.wait')}`
  return t.said(power.text)
}
