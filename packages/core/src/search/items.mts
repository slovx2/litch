// 内容范围由产品规则决定：卡片虽可能来自工具协议，但只取其展示字段，绝不遍历参数/输出。
import type { ItemView } from '../model.mjs'
import { messageCopyText } from '../projection/message-copy.mjs'

export interface SearchPart {
  text: string
  markdown: boolean
}
export function itemSearchParts(item: ItemView): SearchPart[] {
  const text = (value: string | null | undefined): SearchPart[] =>
    value ? [{ text: value, markdown: false }] : []
  switch (item.kind) {
    case 'userMessage':
      return [
        ...text(
          item.event
            ? [
                item.event.body || (item.event.notes.length ? '' : item.event.summary),
                ...item.event.notes.flatMap((note) => [
                  note.title || note.threadId,
                  note.excerpt,
                  note.error,
                ]),
              ]
                .filter(Boolean)
                .join('\n')
            : '',
        ),
        ...text(messageCopyText(item, () => '')),
      ]
    case 'agentMessage':
      return [
        { text: item.text, markdown: true },
        ...(item.questions ?? []).flatMap((q) => text([q.title, ...q.options].join('\n'))),
      ]
    case 'plan':
      return [{ text: item.text, markdown: true }]
    case 'reasoning':
      return text(item.text.trim())
    case 'todo':
      return text([item.note, ...item.steps.map((s) => s.text)].filter(Boolean).join('\n'))
    case 'notice':
      return text(
        [typeof item.label === 'string' ? item.label : '', item.detail].filter(Boolean).join('\n'),
      )
    case 'toolCall': {
      if (item.agents || item.agentActivity) return []
      if (item.spawned) {
        const source = item.spawned
        return source.via === 'offer' || (source.proposalId && !source.threadId)
          ? text([source.title, source.background, source.prompt].filter(Boolean).join('\n'))
          : []
      }
      if (item.asked)
        return text(
          [
            ...item.asked.questions.flatMap((q) => [
              q.header,
              q.question,
              q.answer,
              ...q.options
                .filter((_, i) => !q.picked.includes(i))
                .flatMap((o) => [o.label, o.description]),
            ]),
            item.asked.raw,
          ]
            .filter(Boolean)
            .join('\n'),
        )
      if (item.wrapUp)
        return text(
          [
            item.wrapUp.ask,
            ...(item.wrapUp.ask ? (item.wrapUp.actions ?? []).map((a) => a.label) : []),
            ...item.wrapUp.suggestions.flatMap((s) =>
              s.refused !== null ? [s.title, s.refused] : [s.title, s.background, s.prompt],
            ),
          ]
            .filter(Boolean)
            .join('\n'),
        )
      return []
    }
    // 命令、工具输入输出、子代理、编辑差异、网页工具不在搜索范围内。
    default:
      return []
  }
}
