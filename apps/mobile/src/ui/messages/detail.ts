// 手机端自己的文案：对话区线：对话区的各种条目。键加前缀 "detail."，中英文各一份，键必须一致（en 的类型约束保证）。
// 桌面界面已有的句子（包括核心要说的话）直接用，不在这里重抄：见 src/ui/i18n.ts。
import type { Entry } from '../../../../../packages/ui/src/i18n/types.ts'

export const zhCN = {
  'detail.seconds': '{s} 秒',
  'detail.activity': '活动',
  'detail.group.running': '正在运行：{label}',
  'detail.step.declined': '已拒绝',
  'detail.step.failed': '失败',
  'detail.step.earlier': '已省略前 {n} 行',
  'detail.step.moreLines': '还有 {n} 行，可在“差异”中查看全部',
  'detail.step.noOutput': '无输出',
  'detail.step.moved': '改名为 {path}',
  'detail.step.openDiff': '在差异中查看',
  'detail.step.moreParts': '…还有 {n} 段',
  'detail.reasoning.tap': '点击查看全文',
  /** 一行里“什么：内容”，冒号随语言 */
  'detail.labelled': '{head}：{text}',
  'detail.menu.copyMessage': '复制消息',
  'detail.menu.copyAnswer': '复制回答',
  'detail.menu.copied': '已复制',
  'detail.menu.more': '回合操作',
  'detail.forked.going': '正在分叉…',
  'detail.link.failed': '无法打开链接：{url}',
  'detail.link.noFiles': '此路径不在会话的工作区中，无法打开',
  'detail.image.close': '关闭',
} satisfies Record<`detail.${string}`, Entry>

export const en: Record<keyof typeof zhCN, Entry> = {
  'detail.seconds': '{s}s',
  'detail.activity': 'Activity',
  'detail.group.running': 'Running: {label}',
  'detail.step.declined': 'Declined',
  'detail.step.failed': 'Failed',
  'detail.step.earlier': '{n} earlier lines',
  'detail.step.moreLines': '{n} more lines. See all in Changes',
  'detail.step.noOutput': 'No output',
  'detail.step.moved': 'Renamed to {path}',
  'detail.step.openDiff': 'View in Changes',
  'detail.step.moreParts': '… {n} more parts',
  'detail.reasoning.tap': 'Tap to read all',
  'detail.labelled': '{head}: {text}',
  'detail.menu.copyMessage': 'Copy message',
  'detail.menu.copyAnswer': 'Copy answer',
  'detail.menu.copied': 'Copied',
  'detail.menu.more': 'Turn actions',
  'detail.forked.going': 'Forking…',
  'detail.link.failed': 'Couldn’t open the link: {url}',
  'detail.link.noFiles': 'This path isn’t in the session’s workspace',
  'detail.image.close': 'Close',
}
