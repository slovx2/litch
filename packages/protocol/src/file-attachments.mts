// 普通文件仍经标准 text 输入发送；元数据随原生记录保存，重读时能恢复文件卡。
export interface FileAttachmentRef {
  name: string
  path: string
  location: 'device' | 'client'
  folder?: boolean
  size?: number
  mimeType?: string
}

export const MAX_ATTACHMENT_BYTES = 16 * 1024 * 1024
const OPEN = '<litch-file-attachments>\n'
const CLOSE = '</litch-file-attachments>'
const ABOUT =
  'Attached files (JSON below). Paths with location "device" are on the machine running this session. ' +
  'Paths with location "client" are on the user’s desktop computer running Litch; use litch_machine.read_file or litch_machine.list_dir to access them.'

export function isFileAttachment(value: unknown): value is FileAttachmentRef {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  const short = (s: unknown) => typeof s === 'string' && s.length > 0 && s.length <= 4096
  return (
    short(v.name) &&
    short(v.path) &&
    (v.location === 'device' || v.location === 'client') &&
    (v.folder === undefined || typeof v.folder === 'boolean') &&
    (v.size === undefined || (Number.isSafeInteger(v.size) && (v.size as number) >= 0)) &&
    (v.mimeType === undefined || short(v.mimeType))
  )
}

export function fileAttachmentsBlock(files: readonly FileAttachmentRef[]): string {
  if (!files.length) return ''
  // JSON 转义标签字符和换行，文件名不能提前结束正文块。
  const json = JSON.stringify(files).replace(
    /[<>&]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
  )
  return `${OPEN}${ABOUT}\n${json}\n${CLOSE}`
}

export function parseFileAttachments(
  text: string,
): { files: FileAttachmentRef[]; rest: string } | null {
  const body = text.trimEnd()
  if (!body.endsWith(CLOSE)) return null
  const start = body.lastIndexOf(OPEN)
  if (start < 0 || (start > 0 && body[start - 1] !== '\n')) return null
  const lines = body
    .slice(start + OPEN.length, -CLOSE.length)
    .trimEnd()
    .split('\n')
  if (lines.length !== 2 || lines[0] !== ABOUT) return null
  try {
    const files: unknown = JSON.parse(lines[1] ?? '')
    if (
      !Array.isArray(files) ||
      !files.length ||
      files.length > 16 ||
      !files.every(isFileAttachment)
    )
      return null
    return { files, rest: body.slice(0, start).trimEnd() }
  } catch {
    return null
  }
}

/** 文件类型不依赖 MIME 探测：没有扩展名时由界面给出“文件”。 */
export function attachmentDetail(file: { name: string; size?: number }): string {
  const ext = /\.([^.\\/]+)$/.exec(file.name)?.[1]?.toUpperCase() ?? ''
  const bytes = file.size
  const size =
    bytes === undefined
      ? ''
      : bytes < 1024
        ? `${bytes} B`
        : bytes < 1024 * 1024
          ? `${(bytes / 1024).toFixed(1)} KB`
          : `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return [ext, size].filter(Boolean).join(' · ')
}
