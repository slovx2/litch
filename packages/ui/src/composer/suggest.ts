// 输入框里的“打一个符号弹出一张单子”：认出正在打的那个词、按它过滤和排序。
// 纯逻辑，不碰界面：test/suggest.test.mjs 直接引这个文件，所以只用可擦除的语法、不引样式和组件。

/** 正在打的那个词：从触发符到光标 */
export interface Trigger {
  /** slash：行首的 `/`，列命令和技能；at：一个词开头的 `@`，找工作目录里的文件和目录 */
  kind: 'slash' | 'at'
  /** 触发符在文字里的位置。选中一项之后，从这里到 end 的那一段换掉 */
  start: number
  /** 光标的位置 */
  end: number
  /** 触发符后面已经打的字 */
  query: string
}

const SPACE = /\s/

/**
 * 光标前面是不是正在打一个带触发符的词。触发符到光标之间有空白就不算了（打了空格就是不要这张单子了）。
 * `/` 要在一行的最前面才算：话中间的斜杠多半是路径、是“和/或”；词里又出现斜杠的是路径，也不算。
 * `@` 在一个词的开头就算（话中间也行，前面得是空白）：夹在词中间的是邮箱地址之类的。它后面可以有斜杠，找的就是路径。
 */
export function findTrigger(text: string, caret: number): Trigger | null {
  let start = caret
  while (start > 0 && !SPACE.test(text[start - 1] ?? '')) start--
  // 光标要在触发符后面：停在它前面的不是在打这个词
  if (start === caret) return null
  const query = text.slice(start + 1, caret)
  if (text[start] === '@') return { kind: 'at', start, end: caret, query }
  if (text[start] !== '/') return null
  // 行首：整段的开头，或者前面紧挨着的是换行
  if (start > 0 && text[start - 1] !== '\n') return null
  if (query.includes('/')) return null
  return { kind: 'slash', start, end: caret, query }
}

/** 这个词是不是整个输入框里唯一的东西：对会话办一件事的命令只在这时出现，不夹在写了一半的话里 */
export const standsAlone = (text: string, trigger: Trigger): boolean =>
  text.slice(0, trigger.start).trim() === '' && text.slice(trigger.end).trim() === ''

/** 把触发词从文字里拿掉，返回剩下的文字和光标该落的位置 */
export function cutTrigger(text: string, trigger: Trigger): { text: string; caret: number } {
  const before = text.slice(0, trigger.start)
  // 词后面紧跟着的那一个空格一起拿掉，免得剩下的字前面多一个空格
  const after = text.slice(trigger.end).replace(/^ /, '')
  return { text: before + after, caret: before.length }
}

/** 能被过滤的一项：按 words 里的每个词去对 */
export interface Rankable {
  /** 用来对的词：名字、别名、当前语言里的叫法 */
  words: readonly string[]
}

/**
 * 一个词对上了多少。数越小越靠前：开头就是它 0，中间含着它 1，字母按顺序都出现 2；对不上是 null。
 * 不分大小写。
 */
function score(word: string, query: string): number | null {
  const hay = word.toLowerCase()
  if (hay.startsWith(query)) return 0
  if (hay.includes(query)) return 1
  let at = 0
  for (const char of hay) {
    if (char === query[at]) at++
    if (at === query.length) return 2
  }
  return null
}

/** 按打的字过滤并排序。没打字就是原来的顺序；对得一样好的保持原来的先后 */
export function rank<T extends Rankable>(entries: readonly T[], query: string): T[] {
  const wanted = query.trim().toLowerCase()
  if (!wanted) return [...entries]
  const scored: { entry: T; score: number; at: number }[] = []
  entries.forEach((entry, at) => {
    let best: number | null = null
    for (const word of entry.words) {
      const got = score(word, wanted)
      if (got !== null && (best === null || got < best)) best = got
    }
    if (best !== null) scored.push({ entry, score: best, at })
  })
  return scored.sort((a, b) => a.score - b.score || a.at - b.at).map((item) => item.entry)
}

/** 上下键在单子里走：到头了绕回另一头。一项都没有就是 -1 */
export const step = (count: number, at: number, by: 1 | -1): number =>
  count === 0 ? -1 : (at + by + count) % count
