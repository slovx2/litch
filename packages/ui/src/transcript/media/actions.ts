import type { FileSaveSource } from '@litch/core'
import type { MessageKey } from '../../i18n/index.ts'

/** 工具图片只有缓存标识，不把它伪装成设备文件路径。后续音视频可扩展媒体类型。 */
export type MediaSource =
  | { kind: 'file'; file: FileSaveSource }
  | { kind: 'url'; href: string }
  | { kind: 'tool' }
  | { kind: 'attachment'; file?: FileSaveSource | undefined }

/** 控制端附件没有设备文件身份，不能借会话设备执行 revealFile 或复制成设备路径。 */
export function attachmentSource(file: FileSaveSource | null, client: boolean): MediaSource {
  return { kind: 'attachment', ...(file && !client ? { file } : {}) }
}

export function mediaFile(source: MediaSource): FileSaveSource | null {
  return source.kind === 'file' || source.kind === 'attachment' ? (source.file ?? null) : null
}
export interface ImageAsset {
  url: string
  width: number
  height: number
}
export interface MediaSubject {
  kind: 'image'
  source: MediaSource
  label: string
  image?: ImageAsset | undefined
  /** 工具缩略图的操作按需读取原图，完成后释放，不复制低清缩略图。 */
  load?: (() => Promise<{ image: ImageAsset; release(): void }>) | undefined
}
export type MediaAction =
  | 'copy'
  | 'revealLocal'
  | 'save'
  | 'copyPath'
  | 'files'
  | 'enlarge'
  | 'browser'

export function mediaActions(
  subject: MediaSubject,
  options: {
    copy: boolean
    text: boolean
    destination: 'revealLocal' | 'saveLocal' | null
    enlarge: boolean
  },
): MediaAction[] {
  const actions: MediaAction[] = []
  const ready = !!(subject.image || subject.load)
  const file = mediaFile(subject.source)
  if (options.copy && ready) actions.push('copy')
  if (file && options.destination === 'revealLocal') actions.push('revealLocal')
  if (
    (subject.source.kind === 'file' && options.destination === 'saveLocal') ||
    (subject.source.kind !== 'file' && ready)
  )
    actions.push('save')
  if (options.text && (file || subject.source.kind === 'url')) actions.push('copyPath')
  if (file) actions.push('files')
  if (options.enlarge) actions.push('enlarge')
  if (subject.source.kind === 'url') actions.push('browser')
  return actions
}

export function mediaActionKey(action: MediaAction, source: MediaSource): MessageKey {
  switch (action) {
    case 'copy':
      return 'media.copy'
    case 'save':
      return 'media.menu.save'
    case 'copyPath':
      return source.kind === 'url' ? 'media.menu.copyAddress' : 'files.action.copyFull'
    case 'files':
      return 'media.menu.files'
    case 'enlarge':
      return 'media.menu.enlarge'
    case 'browser':
      return 'media.menu.browser'
    case 'revealLocal':
      return 'files.action.revealManager'
  }
}

/** 灯箱和右键复制共用解码尺寸与 PNG 转换，绝不复制缩略图。 */
export async function copyImage(asset: ImageAsset): Promise<void> {
  const image = new Image()
  image.src = asset.url
  await image.decode()
  const canvas = document.createElement('canvas')
  canvas.width = image.naturalWidth
  canvas.height = image.naturalHeight
  const context = canvas.getContext('2d')
  if (!context) throw new Error('图片尚未加载')
  context.drawImage(image, 0, 0)
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (value) => (value ? resolve(value) : reject(new Error('图片无法复制'))),
      'image/png',
    ),
  )
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
}

export async function downloadImage(asset: ImageAsset, name: string): Promise<void> {
  const link = document.createElement('a')
  link.href = asset.url
  link.download = name.split('/').pop()?.split(/[?#]/)[0] || 'image.png'
  link.click()
  // 下载任务开始后，调用者才可释放临时原图的 Blob URL。
  await new Promise((resolve) => setTimeout(resolve, 0))
}
