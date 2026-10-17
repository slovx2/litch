// 差异页里不靠画面就能算的：一个文件的差异摊成一行一行（合并的视图）、状态的记号。
// 太大的文件、增删行数、文件列表的统计直接用桌面的 packages/ui/src/diff/model.ts。那边的 rowsOf 带展开上下文和并排，
// 行的形状不一样，手机上只要合并的视图，所以这里的 rowsOf 自己排
import type { DiffStatus, FileDiff } from '@litch/core'

export type DiffRow =
  /** 一段改动的开头：@@ -旧起始,行数 +新起始,行数 @@ 所在的函数 */
  | { kind: 'hunk'; key: string; text: string }
  /** 一行：sign 是空格（两边都有）、+（新加）、-（删掉）；行号没有的一边是 null */
  | {
      kind: 'line'
      key: string
      sign: ' ' | '+' | '-'
      old: number | null
      next: number | null
      text: string
    }

export function rowsOf(file: FileDiff): DiffRow[] {
  const rows: DiffRow[] = []
  file.hunks.forEach((hunk, index) => {
    const range = (start: number, lines: number) => (lines === 1 ? `${start}` : `${start},${lines}`)
    rows.push({
      kind: 'hunk',
      key: `h${index}`,
      text: `@@ -${range(hunk.oldStart, hunk.oldLines)} +${range(hunk.newStart, hunk.newLines)} @@${hunk.section ? ` ${hunk.section}` : ''}`,
    })
    let old = hunk.oldStart
    let next = hunk.newStart
    hunk.lines.forEach((line, at) => {
      const sign = line[0]
      const text = line.slice(1)
      const key = `h${index}:${at}`
      if (sign === '+') rows.push({ kind: 'line', key, sign: '+', old: null, next: next++, text })
      else if (sign === '-')
        rows.push({ kind: 'line', key, sign: '-', old: old++, next: null, text })
      else if (sign === ' ')
        rows.push({ kind: 'line', key, sign: ' ', old: old++, next: next++, text })
      // “\ No newline at end of file” 之类的说明行由 noEolOld/noEolNew 另说，不当成一行
    })
  })
  return rows
}

/** 列表里每个文件前面的那个字母（和 git status 的写法一样，人一眼认得；桌面的在 ChangedTree.tsx 里，带 React） */
export const STATUS_LETTER: Record<DiffStatus, string> = {
  modified: 'M',
  added: 'A',
  deleted: 'D',
  renamed: 'R',
  copied: 'C',
  untracked: 'U',
  typeChanged: 'T',
  conflicted: '!',
}

/** 路径拆成目录和文件名：目录淡一些，文件名是主角 */
export function splitPath(path: string): { dir: string; name: string } {
  const at = path.lastIndexOf('/')
  return at < 0 ? { dir: '', name: path } : { dir: path.slice(0, at + 1), name: path.slice(at + 1) }
}
