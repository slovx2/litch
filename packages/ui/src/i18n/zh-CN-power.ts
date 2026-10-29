import type { Entry } from './types.ts'

export const zhPower = {
  'power.quick.name': '接通电源时始终阻止系统休眠',
  'power.quick.on': '常开已启用',
  'power.quick.off': '常开已关闭',
  'power.quick.wait': '接通电源后生效',
  'power.quick.energy': '持续阻止系统空闲休眠会增加耗电；允许熄屏和锁屏。',
  'power.source.ac': '已接通电源',
  'power.source.battery': '正在使用电池',
  'power.source.unknown': '供电状态未知',
  'power.quick.failed': '无法修改电源设置：{reason}',
} satisfies Record<string, Entry>
