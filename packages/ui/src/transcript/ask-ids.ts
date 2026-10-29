// 答复里的题目标识（[工具名, 协议条目的标识, …] 写成的 JSON）认出问题出在哪个条目：
// 问题那一条还在会话里，答复的那条用户消息就并进问题卡，不再单独画。桌面和手机共用
export function questionItemOf(questionId: string): string | null {
  try {
    const parsed: unknown = JSON.parse(questionId)
    return Array.isArray(parsed) && typeof parsed[1] === 'string' ? parsed[1] : null
  } catch {
    return null
  }
}
