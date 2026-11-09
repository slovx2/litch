/** 仅用于 Claude 的错误上下文；普通对话提到策略并不等于遭到拦截。 */
export const CLAUDE_REFUSAL = 'Blocked by Claude safety policy'

export function isClaudeRefusalError(text: unknown): text is string {
  return (
    typeof text === 'string' &&
    (text.includes(CLAUDE_REFUSAL) ||
      /safeguards flagged this message|(?:request|response|message).{0,80}(?:violates?|blocked by).{0,40}(?:usage|safety) polic/i.test(
        text,
      ))
  )
}

export function claudeRefusalError(text = ''): string {
  return text.startsWith(CLAUDE_REFUSAL)
    ? text
    : `${CLAUDE_REFUSAL}${text.trim() ? `\n\n${text.trim()}` : ''}`
}

/** 客户端已展示本地化标题时，只展示原文，避免重复标题。 */
export function claudeRefusalDetail(text: string): string {
  return text.startsWith(CLAUDE_REFUSAL) ? text.slice(CLAUDE_REFUSAL.length).trimStart() : text
}

/** SDK assistant、stream delta、result 的显式停止原因；错误正文是补充证据。 */
export function claudeRefusalOf(
  message: Record<string, unknown>,
  previous: string | null = null,
): string | null {
  const inner = (message.message ?? message.delta ?? message) as Record<string, unknown>
  const content = inner.content
  const text =
    typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content
            .flatMap((block) =>
              block?.type === 'text' && typeof block.text === 'string' ? [block.text] : [],
            )
            .join('\n\n')
        : typeof message.result === 'string' && message.result.trim()
          ? message.result
          : Array.isArray(message.errors)
            ? message.errors.filter((error) => typeof error === 'string').join('\n\n')
            : ''
  const explicit = inner.stop_reason === 'refusal' || message.stop_reason === 'refusal'
  const error =
    message.isApiErrorMessage === true ||
    typeof message.error === 'string' ||
    message.is_error === true ||
    (message.type === 'result' && message.subtype !== 'success')
  return explicit || (error && isClaudeRefusalError(text))
    ? text.trim()
      ? claudeRefusalError(text)
      : (previous ?? CLAUDE_REFUSAL)
    : null
}
