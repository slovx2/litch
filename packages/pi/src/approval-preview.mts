// 文件改动在审批之前给用户看的差异。Pi 的工具只给出要写的全文（write）或替换片段（edit），
// 差异由这里对着磁盘上的现状算出来，放到条目的 changes 上。只在打开了审批、而且这次调用真的要问时才算。
//
// 算不出来时照样问，不拦着：按要写的内容或替换片段给一份补丁，原因写在审批请求的 reason 里。
// 这里的匹配比 Pi 自己的严：Pi 找不到原文时还会做一遍宽松匹配（行尾空白、弯引号等），这里只认逐字相同，
// 对不上的就归到“算不出来”。工具真的执行之后，条目上换成按实际结果算的差异（turn.mts）。
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { createTwoFilesPatch } from 'diff'

export interface FileChange {
  path: string
  kind: { type: 'add' } | { type: 'update'; move_path: null }
  diff: string
}

export interface FilePreview {
  changes: FileChange[]
  /** 没能对着现状算出差异的原因；这时 changes 里的补丁不代表文件里真实的位置。算出来了是 null */
  problem: string | null
}

// 现有的文件超过这么多个字符就不算差异了：逐行比对很大的文件会卡住整个运行时。
const PREVIEW_LIMIT = 1024 * 1024

/** 工具参数里的路径落到哪个文件上：展开 ~，去掉引用用的 @ 前缀，相对路径按工作目录算 */
export function targetPath(cwd: string, path: unknown): string {
  const text = typeof path === 'string' ? path.replace(/^@/, '') : ''
  return resolve(cwd, text.replace(/^~(?=\/|$)/, homedir()))
}

const toLF = (text: string): string => text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
const update = (path: string, diff: string): FileChange => ({
  path,
  kind: { type: 'update', move_path: null },
  diff,
})

// 磁盘上的现状：正文，或者没有这个文件，或者读不了的原因。
function current(file: string): { text: string } | { missing: true } | { problem: string } {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return { missing: true }
    return { problem: `读不了现有的文件（${code ?? String(error)}）` }
  }
  if (text.length > PREVIEW_LIMIT) return { problem: '现有的文件太大，没有逐行比对' }
  return { text }
}

function previewWrite(path: string, file: string, content: string): FilePreview {
  const now = current(file)
  // 协议里新增的文件 diff 放的是正文，只有修改才是补丁。
  if ('missing' in now)
    return { changes: [{ path, kind: { type: 'add' }, diff: content }], problem: null }
  if ('problem' in now)
    return {
      changes: [update(path, createTwoFilesPatch(path, path, '', content))],
      problem: `${now.problem}，下面是要写进去的全文`,
    }
  return {
    changes: [update(path, createTwoFilesPatch(path, path, now.text, content))],
    problem: null,
  }
}

interface Replacement {
  oldText: string
  newText: string
}

// edit 的参数是 edits 数组；模型偶尔直接把一处替换写在顶层，Pi 自己也认，这里一样。
function replacements(input: Record<string, unknown>): Replacement[] {
  const listed = Array.isArray(input.edits) ? input.edits : [input]
  return listed.flatMap((edit) => {
    const { oldText, newText } = (edit ?? {}) as Record<string, unknown>
    return typeof oldText === 'string' && typeof newText === 'string' ? [{ oldText, newText }] : []
  })
}

// 每一处原文在正文里的位置。对不上的返回原因。
function locate(
  base: string,
  edits: Replacement[],
): Array<{ at: number; edit: Replacement }> | string {
  const found: Array<{ at: number; edit: Replacement }> = []
  for (const [index, edit] of edits.entries()) {
    const old = toLF(edit.oldText)
    const at = old ? base.indexOf(old) : -1
    if (at < 0) return `第 ${index + 1} 处要替换的原文在文件里没有逐字找到`
    if (base.indexOf(old, at + 1) >= 0) return `第 ${index + 1} 处要替换的原文在文件里不止一处`
    found.push({ at, edit: { oldText: old, newText: toLF(edit.newText) } })
  }
  found.sort((left, right) => left.at - right.at)
  for (const [index, one] of found.entries()) {
    const next = found[index + 1]
    if (next && one.at + one.edit.oldText.length > next.at) return '有两处替换互相重叠'
  }
  return found
}

function previewEdit(path: string, file: string, input: Record<string, unknown>): FilePreview {
  const edits = replacements(input)
  // 对不上现状时的退路：把替换片段本身当成两份小文件比一下，看得出要换掉什么、换成什么。
  const fragments = (problem: string): FilePreview => ({
    changes: [
      update(
        path,
        createTwoFilesPatch(
          path,
          path,
          edits.map((edit) => toLF(edit.oldText)).join('\n'),
          edits.map((edit) => toLF(edit.newText)).join('\n'),
        ),
      ),
    ],
    problem: `${problem}，下面只是替换片段，行号不是文件里的位置`,
  })
  if (!edits.length) return fragments('没有给出要替换的内容')
  const now = current(file)
  if ('missing' in now) return fragments('文件不存在')
  if ('problem' in now) return fragments(now.problem)
  // 和 Pi 一样：去掉文件头的 BOM、行尾统一成 LF 之后再找。
  const base = toLF(now.text.replace(/^\uFEFF/, ''))
  const found = locate(base, edits)
  if (typeof found === 'string') return fragments(found)
  let next = base
  for (const { at, edit } of found.toReversed())
    next = next.slice(0, at) + edit.newText + next.slice(at + edit.oldText.length)
  if (next === base) return fragments('替换前后内容一样')
  return { changes: [update(path, createTwoFilesPatch(path, path, base, next))], problem: null }
}

/** 一次写文件或改文件的调用会带来的改动。toolName 是 write 时按全文算，其余按替换片段算 */
export function previewFileChange(
  cwd: string,
  toolName: string,
  input: Record<string, unknown>,
): FilePreview {
  const path = typeof input.path === 'string' ? input.path : ''
  const file = targetPath(cwd, path)
  if (toolName === 'write')
    return previewWrite(path, file, typeof input.content === 'string' ? input.content : '')
  return previewEdit(path, file, input)
}
