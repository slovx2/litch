// 文件面板的几样投影，都是纯函数：
// - 协议给的一层目录 → 排好序的条目；
// - 一个文件名 → 它是哪种语言、是不是不该按文字读的那几类；
// - 读回来的字节 → 文字、太大、不是文字；
// - 各层目录加上“哪些展开着” → 摊平的行（界面只画看得见的那几十行）。
import type { FsReadDirectoryEntry } from '../../../protocol/src/index.mjs'
import type { ChannelErrorShape } from '../channel/protocol.mjs'
import type { DirectoryView, FileContent, FileEntry, FileGroup, FileRow } from '../model-files.mjs'
import { base64Bytes, decodeBase64, decodeUtf8 } from '../text/bytes.mjs'
import { baseName, extensionOf } from '../text/paths.mjs'

/** 一层目录最多给界面这么多项。再多的不给，界面上说明还有多少 */
export const MAX_ENTRIES = 100_000
/** 文件超过这么多字节就不显示内容 */
export const MAX_TEXT_BYTES = 2 * 1024 * 1024
/** 看开头这么多字节里有没有零字节，有就不是文字 */
const SNIFF_BYTES = 8192

/** 目录在前，同类按名字排（不分大小写；只差大小写的按原样比，结果是确定的）。返回新的数组 */
export function sortEntries(entries: readonly FileEntry[]): FileEntry[] {
  // 小写的名字先算好：几万项的目录里，比较函数要被叫上几十万次
  const keyed = entries.map((entry) => ({ key: entry.name.toLowerCase(), entry }))
  const rank = (entry: FileEntry): number => (entry.kind === 'dir' ? 0 : 1)
  keyed.sort(
    (a, b) =>
      rank(a.entry) - rank(b.entry) ||
      (a.key < b.key ? -1 : a.key > b.key ? 1 : 0) ||
      (a.entry.name < b.entry.name ? -1 : a.entry.name > b.entry.name ? 1 : 0),
  )
  return keyed.map((item) => item.entry)
}

/** 协议给的一层目录 → 排好序的条目。太多的只留前面的，total 是实际有多少 */
export function projectDirectory(path: string, entries: FsReadDirectoryEntry[]): DirectoryView {
  const listed: FileEntry[] = []
  for (const raw of entries) {
    // 对面给的东西不能只靠类型：名字不是字、是空的、带斜杠的都不要
    if (typeof raw?.fileName !== 'string' || raw.fileName === '' || raw.fileName.includes('/')) {
      continue
    }
    if (raw.fileName === '.' || raw.fileName === '..') continue
    const kind = raw.isDirectory === true ? 'dir' : raw.isFile === true ? 'file' : 'other'
    listed.push({ name: raw.fileName, kind })
  }
  const all = sortEntries(listed)
  return {
    path,
    entries: all.length > MAX_ENTRIES ? all.slice(0, MAX_ENTRIES) : all,
    total: all.length,
  }
}

/** 扩展名 → 上色库认的语言名（界面用的是它的常用语言那一包） */
const LANGUAGES: Record<string, string> = {
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'javascript',
  json: 'json',
  jsonc: 'json',
  json5: 'json',
  md: 'markdown',
  markdown: 'markdown',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'ini',
  ini: 'ini',
  cfg: 'ini',
  conf: 'ini',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  py: 'python',
  go: 'go',
  rs: 'rust',
  java: 'java',
  kt: 'kotlin',
  kts: 'kotlin',
  swift: 'swift',
  c: 'c',
  h: 'c',
  cc: 'cpp',
  cpp: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  css: 'css',
  scss: 'scss',
  less: 'less',
  html: 'xml',
  htm: 'xml',
  xml: 'xml',
  svg: 'xml',
  vue: 'xml',
  plist: 'xml',
  sql: 'sql',
  rb: 'ruby',
  php: 'php',
  lua: 'lua',
  pl: 'perl',
  r: 'r',
  m: 'objectivec',
  mm: 'objectivec',
  diff: 'diff',
  patch: 'diff',
  graphql: 'graphql',
  gql: 'graphql',
  mk: 'makefile',
}

/** 没有扩展名、靠整个名字认的 */
const NAMED: Record<string, string> = {
  makefile: 'makefile',
  gnumakefile: 'makefile',
}

/** 上色用的语言。认不出来是 null */
export function languageOf(path: string): string | null {
  const name = baseName(path).toLowerCase()
  return NAMED[name] ?? LANGUAGES[extensionOf(name)] ?? null
}

const GROUPS: [FileGroup, string][] = [
  ['image', 'png jpg jpeg gif webp bmp ico icns tif tiff heic heif avif psd'],
  ['audio', 'mp3 wav flac aac ogg oga m4a opus aiff'],
  ['video', 'mp4 mov mkv avi webm m4v wmv flv mpg mpeg'],
  ['archive', 'zip tar gz tgz bz2 xz zst 7z rar jar war dmg iso pkg deb rpm apk asar'],
  ['document', 'pdf doc docx xls xlsx ppt pptx odt ods odp epub'],
  ['font', 'ttf otf woff woff2 eot'],
  ['database', 'sqlite sqlite3 db mdb'],
  ['executable', 'exe dll so dylib a o obj lib bin class pyc pyo wasm node'],
]
const GROUP_OF = new Map<string, FileGroup>()
for (const [group, extensions] of GROUPS) {
  for (const extension of extensions.split(' ')) GROUP_OF.set(extension, group)
}

/** 看扩展名就知道不该按文字读的那几类。不是这几类的是 null：读了再说 */
export const unreadableGroup = (path: string): FileGroup | null =>
  GROUP_OF.get(extensionOf(path)) ?? null

/** 读回来的内容（base64）→ 界面看到的样子。字节数先从 base64 的长度算，太大的不去解 */
export function projectFile(path: string, dataBase64: string): FileContent {
  const bytes = base64Bytes(dataBase64)
  if (bytes > MAX_TEXT_BYTES) return { kind: 'tooLarge', path, bytes, limit: MAX_TEXT_BYTES }
  const data = decodeBase64(dataBase64)
  const head = Math.min(data.length, SNIFF_BYTES)
  for (let at = 0; at < head; at++) {
    if (data[at] === 0) return { kind: 'binary', path, group: 'binary', bytes: data.length }
  }
  const tally = { replaced: 0 }
  let text = decodeUtf8(data, tally)
  // 开头的字节序标记不是内容
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  // 换行统一成 \n：界面按行切，不想在每一行末尾留一个看不见的 \r
  if (text.includes('\r')) text = text.replace(/\r\n?/g, '\n')
  return {
    kind: 'text',
    path,
    text,
    bytes: data.length,
    language: languageOf(path),
    lossy: tally.replaced > 0,
  }
}

/** 一层目录在树里的状况。view 留着上一次取到的：重新取的时候先照旧显示 */
export interface TreeListing {
  state: 'loading' | 'ready' | 'failed'
  view: DirectoryView | null
  error: ChannelErrorShape | null
}

const isHidden = (name: string): boolean => name.startsWith('.')

/**
 * 把一棵树摊平成行：从根那一层起，展开着的目录下面接它的内容。根自己不占一行。
 * 目录还没取到内容的，下面是一行说明（正在取、没取到）；取到了但没有可显示的，是一行“空的”。
 */
export function flattenTree(
  root: string,
  listings: ReadonlyMap<string, TreeListing>,
  expanded: ReadonlySet<string>,
  showHidden: boolean,
): FileRow[] {
  const rows: FileRow[] = []
  const note = (path: string, depth: number, kind: FileRow['kind'], extra: FileRow['note']) => {
    rows.push({ id: `${path}\n${kind}`, path, name: '', depth, kind, expanded: false, note: extra })
  }
  const walk = (dir: string, depth: number) => {
    const listing = listings.get(dir)
    const view = listing?.view
    if (!view) {
      if (listing?.state === 'failed' && listing.error) {
        note(dir, depth, 'failed', { kind: 'failed', error: listing.error })
      } else note(dir, depth, 'loading', null)
      return
    }
    let shown = 0
    const prefix = dir === '/' ? '/' : `${dir}/`
    for (const entry of view.entries) {
      if (!showHidden && isHidden(entry.name)) continue
      shown++
      const path = prefix + entry.name
      const open = entry.kind === 'dir' && expanded.has(path)
      rows.push({
        id: path,
        path,
        name: entry.name,
        depth,
        kind: entry.kind,
        expanded: open,
        note: null,
      })
      if (open) walk(path, depth + 1)
    }
    if (view.total > view.entries.length) {
      note(dir, depth, 'truncated', {
        kind: 'truncated',
        hidden: view.total - view.entries.length,
      })
    } else if (shown === 0) note(dir, depth, 'empty', null)
  }
  walk(root, 0)
  return rows
}
