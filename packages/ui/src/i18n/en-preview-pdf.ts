import type { zhPreviewPdf } from './zh-CN-preview-pdf.ts'
export const enPreviewPdf: Record<keyof typeof zhPreviewPdf, string> = {
  'preview.pdf.title': 'PDF preview',
  'preview.pdf.controls': 'PDF pages and zoom',
  'preview.pdf.page': 'Page number',
  'preview.pdf.pageLabel': 'Page {page}',
  'preview.pdf.total': '/ {count}',
  'preview.pdf.previous': 'Previous',
  'preview.pdf.next': 'Next',
  'preview.pdf.loading': 'Rendering PDF…',
  'preview.pdf.invalid': 'Unable to preview this PDF. The file may be damaged.',
  'preview.pdf.encrypted': 'This PDF requires a password. Open it in another app.',
  'preview.pdf.pages': 'PDFs over 200 pages cannot be previewed.',
  'preview.pdf.size': 'The PDF exceeds 20 MiB or its pages are too large to preview.',
  'preview.pdf.timeout': 'PDF processing timed out. Preview stopped.',
  'preview.pdf.textLimit': 'Too much text on this page. Only the page image is shown.',
}
