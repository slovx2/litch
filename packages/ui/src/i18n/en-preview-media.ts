import type { zhPreviewMedia } from './zh-CN-preview-media.ts'
export const enPreviewMedia: Record<keyof typeof zhPreviewMedia, string> = {
  'preview.media.play': 'Play',
  'preview.media.pause': 'Pause',
  'preview.media.duration': 'Preview supports clips up to 5 minutes. Save the file to play it.',
  'preview.media.size': 'This video exceeds the preview pixel limit. Save it to play it.',
  'preview.media.note': 'Local decoding · Format support depends on this system',
  'preview.media.audio': 'Audio preview',
  'preview.media.video': 'Video preview',
  'preview.media.invalid':
    'Cannot play this file. It may be damaged, or its codec may not be supported on this system.',
}
