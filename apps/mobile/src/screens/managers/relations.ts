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
