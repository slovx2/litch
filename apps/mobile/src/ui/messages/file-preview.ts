import type { Entry } from '../../../../../packages/ui/src/i18n/types.ts'

export const zhCN = {
  'mobilePreview.unsupportedFormat': '此格式暂不支持在手机上预览，可在桌面查看',
  'mobilePreview.unsupported': '此设备尚不支持文件预览，请升级设备服务后重试。',
  'mobilePreview.loading': '正在加载预览…',
  'mobilePreview.tooLarge': '文件超过手机预览上限（{limit}），请在桌面查看。',
  'mobilePreview.invalid': '文件已损坏或无法解码，请在桌面查看。',
  'mobilePreview.imageInvalid':
    '图片已损坏、包含动画或超过像素上限（2000 万像素，单边 16384），请在桌面查看。',
  'mobilePreview.encrypted': '手机暂不支持加密 PDF，请在桌面查看。',
  'mobilePreview.pages': 'PDF 超过 200 页，请在桌面查看。',
  'mobilePreview.size': 'PDF 页面超过尺寸上限，请在桌面查看。',
  'mobilePreview.timeout': '文件处理超时，请在桌面查看。',
  'mobilePreview.missing': '文件已不存在。',
  'mobilePreview.outside': '设备拒绝访问此路径。',
  'mobilePreview.notFile': '此路径不是普通文件。',
  'mobilePreview.changed': '文件在读取时发生变化，请重试。',
  'mobilePreview.busy': '设备正在处理其他预览，请稍后重试。',
  'mobilePreview.failed': '预览失败，请重试或在桌面查看。',
  'mobilePreview.copy': '复制路径',
  'mobilePreview.copyFailed': '复制失败，请重试。',
  'mobilePreview.previous': '上一页',
  'mobilePreview.next': '下一页',
  'mobilePreview.page': '第 {page} / {pages} 页',
  'mobilePreview.hint': '双指缩放 · 拖动平移 · 双击复原',
} as const

export const en: Record<keyof typeof zhCN, Entry> = {
  'mobilePreview.unsupportedFormat':
    'This format cannot be previewed on mobile yet. View it on desktop.',
  'mobilePreview.unsupported': 'Update the device service to enable file previews, then try again.',
  'mobilePreview.loading': 'Loading preview…',
  'mobilePreview.tooLarge':
    'This file exceeds the mobile preview limit ({limit}). View it on desktop.',
  'mobilePreview.invalid': 'This file is damaged or could not be decoded. View it on desktop.',
  'mobilePreview.imageInvalid':
    'This image is damaged, animated, or exceeds the pixel limit (20 megapixels; 16,384 per side). View it on desktop.',
  'mobilePreview.encrypted': 'Encrypted PDFs are not supported on mobile. View it on desktop.',
  'mobilePreview.pages': 'This PDF exceeds 200 pages. View it on desktop.',
  'mobilePreview.size': 'This PDF exceeds the page size limit. View it on desktop.',
  'mobilePreview.timeout': 'Processing timed out. View this file on desktop.',
  'mobilePreview.missing': 'This file no longer exists.',
  'mobilePreview.outside': 'The device denied access to this path.',
  'mobilePreview.notFile': 'This path is not a regular file.',
  'mobilePreview.changed': 'The file changed while it was being read. Try again.',
  'mobilePreview.busy': 'The device is processing another preview. Try again shortly.',
  'mobilePreview.failed': 'Preview failed. Try again or view it on desktop.',
  'mobilePreview.copy': 'Copy path',
  'mobilePreview.copyFailed': 'Could not copy the path. Try again.',
  'mobilePreview.previous': 'Previous',
  'mobilePreview.next': 'Next',
  'mobilePreview.page': 'Page {page} of {pages}',
  'mobilePreview.hint': 'Pinch to zoom · Drag to pan · Double-tap to reset',
}
