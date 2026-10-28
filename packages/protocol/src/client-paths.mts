// 远程设备的会话里提到这台桌面端上的文件、文件夹：发出去时正文怎么写，对话里又怎么从用户消息里认回来。
// 路径不在会话所在的设备上，harness 自己读不到；只有那台设备打开了“操作这台电脑”（litch_machine）时才这样带，
// 模型用 litch_machine 的 read_file、list_dir 去读。不往设备上传文件，也不展开目录。
// 写法是正文末尾一段 <litch-client-paths>；提到会话的那一段（session-mentions.mts）要在最末尾，有它时这一段排在它前面，
// 认回来时先拆掉会话那一段再认这一段。
// 认回来只看文字本身，桌面端和手机端用同一套。

export const CLIENT_PATH_TAG = 'litch-client-paths'

/** 提到的一个本机路径。folder 为真时 path 以 / 结尾 */
export interface ClientPathRef {
  path: string
  folder: boolean
}

export interface ParsedClientPaths {
  paths: ClientPathRef[]
  /** 那一段前面的正文 */
  rest: string
}

/** 给模型的说明。固定用英文：各家模型都看得懂，认回来时也不看它 */
const ABOUT =
  "These paths are on the user's desktop computer (the one running Litch), not on the machine you run on. " +
  'Read them with litch_machine (read_file, list_dir) when you need their contents; folders are listed, not attached.'

const OPEN = `<${CLIENT_PATH_TAG}>\n`
const CLOSE = `</${CLIENT_PATH_TAG}>`

const escapeTags = (value: string) =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const unescapeTags = (value: string) =>
  value.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')

/** 文件夹的路径末尾补一个 /（已经有 / 或 \ 的不补） */
export const folderPath = (path: string): string => (/[\\/]$/.test(path) ? path : `${path}/`)

/** 提到的几个本机路径写成的那一段；一个都没有是空字符串 */
export function clientPathsBlock(refs: readonly ClientPathRef[]): string {
  if (refs.length === 0) return ''
  const lines = [`<${CLIENT_PATH_TAG}>`, ABOUT]
  for (const ref of refs) {
    const kind = ref.folder ? 'folder' : 'file'
    const path = ref.folder ? folderPath(ref.path) : ref.path
    lines.push(`<path kind="${kind}">${escapeTags(path)}</path>`)
  }
  lines.push(CLOSE)
  return lines.join('\n')
}

/** 正文末尾是这一段的，拆成路径和前面的正文；不是、或者格式坏了，返回 null，照原文显示 */
export function parseClientPaths(text: string): ParsedClientPaths | null {
  const body = text.replace(/\s+$/, '')
  if (!body.endsWith(CLOSE)) return null
  const start = body.lastIndexOf(OPEN)
  if (start < 0 || (start > 0 && body[start - 1] !== '\n')) return null
  const inner = body.slice(start + OPEN.length, body.length - CLOSE.length)
  const paths: ClientPathRef[] = []
  for (const match of inner.matchAll(/^<path kind="(file|folder)">([^<\n]+)<\/path>$/gm)) {
    paths.push({ folder: match[1] === 'folder', path: unescapeTags(match[2] ?? '') })
  }
  if (paths.length === 0) return null
  return { paths, rest: body.slice(0, start).replace(/\s+$/, '') }
}
