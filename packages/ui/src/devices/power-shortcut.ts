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
