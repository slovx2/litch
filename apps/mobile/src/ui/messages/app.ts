// 手机端自己的文案：基础（导航、通用组件、启动、设置以外的通用句子）。键加前缀 "app."，中英文各一份，键必须一致。
// 桌面界面已有的句子（包括核心要说的话）直接用，不在这里重抄：见 src/ui/i18n.ts。
import type { Entry } from '../../../../../packages/ui/src/i18n/types.ts'

export const zhCN = {
  'app.selectSession': '选择一个会话',
  'app.back': '返回',
  'app.cancel': '取消',
  'app.done': '完成',
  'app.retry': '重试',
  'app.dismiss': '关闭',
  'app.booting': '启动中…',
  'app.bootFailed': '核心启动失败：{error}',
  'app.mockBadge': '模拟核心',
  'app.fixtureBadge': '测试夹具',
  'app.todo': '此页面尚未完成',
  'app.valued': '{name}：{value}',
  'app.privacy': '隐私政策',
  'app.support': '支持与反馈',
  'app.openLinkFailed': '无法打开网页，请检查网络连接。',
} satisfies Record<`app.${string}`, Entry>

export const en: Record<keyof typeof zhCN, Entry> = {
  'app.selectSession': 'Select a conversation',
  'app.back': 'Back',
  'app.cancel': 'Cancel',
  'app.done': 'Done',
  'app.retry': 'Retry',
  'app.dismiss': 'Dismiss',
  'app.booting': 'Starting…',
  'app.bootFailed': 'The core couldn’t start: {error}',
  'app.mockBadge': 'Mock core',
  'app.fixtureBadge': 'Test fixture',
  'app.todo': 'This page isn’t ready yet',
  'app.valued': '{name}: {value}',
  'app.privacy': 'Privacy policy',
  'app.support': 'Support',
  'app.openLinkFailed': 'Could not open the page. Check your connection.',
}
