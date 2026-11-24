// 编号只给当前经理真实存在的对象加链接；显式链接和代码片段保持原样。
export function issueLinks(text: string, ids: ReadonlySet<string>, deferred = false): string {
  return text
    .split(/(```[\s\S]*?```|`[^`]*`|\[[^\]]*\]\([^)]*\))/g)
    .map((part) =>
      part.startsWith('`') || part.startsWith('[')
        ? part
        : part.replace(/(?<!\w)#?[DIRP]-\d+(?!\w)/g, (word) => {
            const id = word.replace(/^#/, '')
            return deferred || ids.has(id) ? `[#${id}](litch-issue:${id})` : word
          }),
    )
    .join('')
}

type Edge<T> = { from: T; to: T }
type End = { kind: string; target: string }

/**
 * 议题页讨论区那一行“关联 N”画哪些对端。
 * 设备给看板的关联去掉了一端是 X-n（普通议题）的边，所以特殊议题的卡上看不到它和普通议题的关联；
 * 有议题卡时这里只补这部分，卡上已有的不再画一遍。没有议题卡（普通议题）时画全部。
 */
export function threadRelationTargets<T extends End>(
  id: string,
  relations: readonly Edge<T>[],
  withCard: boolean,
): T[] {
  const ends = relations.flatMap((edge) =>
    edge.from.kind === 'issue' && edge.from.target === id
      ? [edge.to]
      : edge.to.kind === 'issue' && edge.to.target === id
        ? [edge.from]
        : [],
  )
  return withCard ? ends.filter((end) => end.target.startsWith('X-')) : ends
}
