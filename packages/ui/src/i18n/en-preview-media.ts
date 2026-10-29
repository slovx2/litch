import type { zhPreviewMedia } from './zh-CN-preview-media.ts'
export const enPreviewMedia: Record<keyof typeof zhPreviewMedia, string> = {
  'preview.media.note': 'Local decoding · Format support depends on this system',
  'preview.media.audio': 'Audio preview',
  'preview.media.video': 'Video preview',
  'preview.media.invalid':
    'Cannot play this file. It may be damaged, or its codec may not be supported on this system.',
}
