import type { Entry } from './types.ts'
export const zhModelRanking = {
  'ranking.choose': '本次使用 {model}',
  'ranking.title': '模型等级排序',
  'ranking.open': '管理等级',
  'ranking.builtin': '内置排序：仅比较同一引擎的模型',
  'ranking.custom': '自定义排序：所有引擎共同比较',
  'ranking.note':
    '上方等级更高，同组模型并级。拖动模型或选择目标等级。保存自定义后，跨引擎派发也受上限约束。',
  'ranking.unknownNote':
    '未分级型号仅允许沿用父会话的同一身份；换型号前请先分级，或在卡片中亲自选择。',
  'ranking.unranked': '未分级',
  'ranking.level': '第 {level} 级',
  'ranking.new': '单独一级（最高）',
  'ranking.save': '保存自定义排序',
  'ranking.reset': '恢复内置排序',
  'ranking.resetNote': '清除自定义排序，跨引擎派发将不再比较等级。',
  'ranking.refresh': '重新读取',
  'ranking.unavailable': '暂不可用',
  'ranking.partial': '部分模型未能读取',
  'ranking.unsaved': '有未保存的修改',
  'ranking.loading': '正在读取模型',
  'ranking.close': '关闭',
  'ranking.cancel': '取消',
  'ranking.move': '移动模型',
} satisfies Record<string, Entry>
