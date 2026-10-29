import type { zhPreview } from './zh-CN-preview.ts'
export const enPreview: Record<keyof typeof zhPreview, string> = {
  'preview.zoomIn': 'Zoom in',
  'preview.zoomOut': 'Zoom out',
  'preview.view': 'Preview',
  'preview.source': 'Source',
  'preview.fit': 'Fit width',
  'preview.actual': 'Actual size',
  'preview.unsupported':
    'This device does not support bounded file previews. Update its device service.',
  'preview.outside': 'The file points outside the project root and cannot be previewed.',
  'preview.notFile': 'This path is not a regular file.',
  'preview.changed': 'The file changed while reading. Refresh to try again.',
  'preview.busy': 'The device is reading other previews. Refresh shortly.',
  'preview.invalid': 'Invalid file contents or unsupported format.',
  'preview.blocked': 'This resource is not loaded automatically',
  'preview.imageLimit': 'Invalid, animated or oversized image.',
  'preview.anchorMissing': 'This heading was not found in the document.',
}
