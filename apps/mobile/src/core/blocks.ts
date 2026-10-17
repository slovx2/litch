// 把一段只会往后长的 Markdown 切成“块”：已经写完的块内容不再变，只有最后一块在长。
// 对话区每块一行：流式时只有最后那一行在重排，十万字的回答进入时也只解析看得见的几行。
//
// 块的边界：代码块之外的空行。代码块（``` 或 ~~~ 围起来的）整个算在一块里，不从中间切。
// 太碎的块（一个标题、一行字）并成一组再出行，一组到了 experiment.seal 个字就封口，之后的块进下一组。
// 文字只往后长，所以封了口的组永远不变：行的标识（条目标识加组号）和内容在流式和定稿之间都稳定。

import { experiment } from '../experiment'

export interface Chunk {
  /** 第几组，从 0 开始。和条目标识一起做行的标识 */
  index: number
  text: string
  /** 最后一组：还在长（条目还在流式时） */
  open: boolean
}

/** 记下切到哪了，下次只从那里往后看。同一条文字（只会变长）反复调用 */
export interface ChunkState {
  /** 已经封口的组 */
  sealed: Chunk[]
  /** 封口的组一共占了原文多少个字 */
  consumed: number
}

export const emptyChunks = (): ChunkState => ({ sealed: [], consumed: 0 })

/**
 * 找出 text 里从 from 开始、已经写完的块的末尾（空行之后的位置）。没有写完的块返回 -1。
 * fenced：from 这里是不是在代码块里面（调用方从封口处开始，封口处一定不在代码块里）
 */
function completedBlocks(text: string, from: number): number[] {
  const ends: number[] = []
  let fence: string | null = null
  let at = from
  while (at < text.length) {
    const newline = text.indexOf('\n', at)
    if (newline < 0) break
    const line = text.slice(at, newline)
    const trimmed = line.trimStart()
    if (fence) {
      if (trimmed.startsWith(fence)) fence = null
    } else if (trimmed.startsWith('```') || trimmed.startsWith('~~~')) {
      fence = trimmed.slice(0, 3)
    } else if (trimmed === '') {
      ends.push(newline + 1)
    }
    at = newline + 1
  }
  return ends
}

/**
 * 按新的全文更新分组，返回全部的组（封口的加上最后那一组）。
 * 新文字不是旧文字往后长出来的（定稿时对面给的最终内容和流式拼出来的不一样）就从头切。
 */
export function chunkText(state: ChunkState, text: string, previous: string | null, open: boolean): Chunk[] {
  if (previous !== null && !text.startsWith(previous.slice(0, state.consumed))) {
    state.sealed = []
    state.consumed = 0
  }
  if (!open) {
    // 定稿了：剩下的全部封口（还按同样的规矩分组，已经封口的不动）
    sealFrom(state, text, true)
    return state.sealed
  }
  sealFrom(state, text, false)
  const tail = text.slice(state.consumed)
  return tail ? [...state.sealed, { index: state.sealed.length, text: tail, open: true }] : state.sealed
}

function sealFrom(state: ChunkState, text: string, all: boolean): void {
  const ends = completedBlocks(text, state.consumed)
  let start = state.consumed
  for (const end of ends) {
    if (end - start >= experiment.seal) {
      state.sealed.push({ index: state.sealed.length, text: trimEnd(text.slice(start, end)), open: false })
      start = end
    }
  }
  state.consumed = start
  if (all && start < text.length) {
    const rest = trimEnd(text.slice(start))
    if (rest) state.sealed.push({ index: state.sealed.length, text: rest, open: false })
    state.consumed = text.length
  }
}

const trimEnd = (text: string): string => text.replace(/\s+$/, '')
