import type { zhPreviewHtml } from './zh-CN-preview-html.ts'
export const enPreviewHtml: Record<keyof typeof zhPreviewHtml, string> = {
  'preview.html.title': 'Static HTML preview',
  'preview.html.static':
    'Static preview · Scripts, forms, navigation and network resources are disabled',
  'preview.html.blocked': 'Images not loaded: {count}',
  'preview.html.imageBlocked': 'Image not loaded',
  'preview.html.invalid':
    'Cannot preview this HTML: invalid encoding or document structure exceeds the limit. View the source instead.',
}
