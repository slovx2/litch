// 模型或用户写的 Markdown 放进一行摘要时用：去掉排版记号，只留文字。整段内容要渲染的用 CardMarkdown。
/** 一行纯文字：取第一行非空内容，去掉常见 Markdown 记号。 */
export function plainLine(text: string): string {
  const line = text.split('\n').find((l) => l.trim()) ?? ''
  return line
    .replace(/^\s*(#{1,6}\s+|[-*+]\s+|\d+\.\s+|>\s*)/, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__|\*|_|~~|`)/g, '')
    .trim()
}

/**
 * 多行摘要（比如设备截的正文前 160 字）：每行去掉 Markdown 记号后接成一段。
 * 截断可能切在一对 ** 中间，剩下的单个记号也一并去掉，不让 **加粗** 原样露出来。
 */
export function plainPreview(text: string): string {
  return text
    .split('\n')
    .map((line) => plainLine(line))
    .filter(Boolean)
    .join(' ')
}
