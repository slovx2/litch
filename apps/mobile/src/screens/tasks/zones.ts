// 时区的选项：手机所在的、任务原来的、现在选着的排在前面，后面是一份常用的；都没有的点“其他时区”自己填。
// 认不认识用桌面界面的 zoneKnown（packages/ui/src/tasks/preview.ts，和设备上校验用的是同一个函数）。
const COMMON = [
  'UTC',
  'Asia/Shanghai',
  'Asia/Hong_Kong',
  'Asia/Taipei',
  'Asia/Tokyo',
  'Asia/Seoul',
  'Asia/Singapore',
  'Asia/Kolkata',
  'Asia/Dubai',
  'Europe/London',
  'Europe/Paris',
  'Europe/Berlin',
  'Europe/Moscow',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'America/Sao_Paulo',
  'Australia/Sydney',
  'Pacific/Auckland',
]

export function zoneChoices(
  local: string,
  original: string | null,
  current: string | null,
): string[] {
  const front = [local, original, current].filter((zone): zone is string => !!zone)
  return [...new Set([...front, ...COMMON])]
}
