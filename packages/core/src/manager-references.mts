// 对话和看板共用编号边界；建议沿用 S-<proposalId>，不把路径或单词的一部分当编号。
export const managerReferencePattern = () =>
  /(?<![\w/#-])#?(?:[DIRPX]-\d+|S-[\w]+(?:-[\w]+)*)(?![\w-])/g
export const managerReferenceIds = (text: string): string[] => [
  ...new Set(
    [...text.matchAll(managerReferencePattern())].map((match) => match[0].replace(/^#/, '')),
  ),
]

/** 同一对话里的重复引用只核对一次，在途读取也共享；切经理时重新创建。 */
export function managerReferencesResolver(read: (ids: string[]) => Promise<string[]>) {
  const cache = new Map<string, Promise<boolean>>()
  return async (ids: string[]): Promise<Set<string>> => {
    const missing = ids.filter((id) => !cache.has(id))
    for (let offset = 0; offset < missing.length; offset += 100) {
      const batch = missing.slice(offset, offset + 100)
      const result = read(batch).then((found) => new Set(found))
      for (const id of batch)
        cache.set(
          id,
          result.then(
            (found) => found.has(id),
            () => {
              cache.delete(id)
              return false
            },
          ),
        )
    }
    const found = await Promise.all(ids.map(async (id) => ((await cache.get(id)) ? id : null)))
    return new Set(found.filter((id): id is string => id !== null))
  }
}

/** 只改正文，跳过围栏（包括尚未闭合）、缩进代码、行内代码、显式链接和自动链接。 */
export function mapManagerMarkdown(text: string, transform: (text: string) => string): string {
  let fence: { char: string; length: number } | null = null
  return text
    .split(/(?<=\n)/)
    .map((line) => {
      const source = line.replace(/^ {0,3}(?:> ?)+/, '')
      const marker = source.match(/^ {0,3}(`{3,}|~{3,})/)
      if (fence) {
        if (
          marker &&
          marker[1]?.[0] === fence.char &&
          marker[1].length >= fence.length &&
          /^\s*$/.test(source.slice((marker.index ?? 0) + marker[0].length))
        )
          fence = null
        return line
      }
      if (marker) {
        fence = { char: marker[1]?.[0] ?? '`', length: marker[1]?.length ?? 3 }
        return line
      }
      if (/^(?: {4}|\t)/.test(source)) return line
      return line
        .split(/(`+[^\n]*?`+|!?\[[^\]]*\](?:\([^)]*\)|\[[^\]]*\])|<[^>]*>)/g)
        .map((part, index) => (index % 2 ? part : transform(part)))
        .join('')
    })
    .join('')
}
