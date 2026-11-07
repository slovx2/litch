/** 看板编号的显示写法：建议的编号是 S- 加提案 uuid，太长，只留前 8 位（完整编号放悬停提示）；其他编号原样 */
export function shortObjectId(id: string): string {
  return id.startsWith('S-') && id.length > 10 ? id.slice(0, 10) : id
}

/** 背景首句用作做/不做的判断依据；没有背景的 fork/旧卡退回任务首句。 */
export function proposalSummary(background: string | undefined, prompt: string): string {
  const text = (background?.trim() || prompt.trim())
    .replace(/^\s*#{1,6}\s+.*$/gm, '')
    .replace(/^\s*(?:[-*+]\s+|\d+\.\s+|>\s*)/gm, '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\*\*|__|~~|`/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  // 英文句点后须有空白或结尾，避免把文件名、网址、版本号截成半句。
  const end = text.search(/[。！？!?]|\.(?=\s|$)/)
  const sentence = end < 0 ? text : text.slice(0, end + 1)
  const chars = Array.from(sentence)
  return chars.length > 200 ? `${chars.slice(0, 200).join('')}…` : sentence
}
