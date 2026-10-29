// 资源作为构建内的惰性 JS 数据模块装载。connect-src 仍为 none，不接受文档提供的 URL。
const assets = import.meta.glob<string>(
  [
    '/node_modules/pdfjs-dist/cmaps/*.bcmap',
    '/node_modules/pdfjs-dist/standard_fonts/*.{pfb,ttf}',
    '/node_modules/pdfjs-dist/wasm/{openjpeg,jbig2,qcms_bg}.wasm',
  ],
  { query: '?url&inline', import: 'default' },
)
const folders: Record<string, string> = {
  cMapUrl: 'cmaps',
  standardFontDataUrl: 'standard_fonts',
  wasmUrl: 'wasm',
}
export class LocalPdfData {
  async fetch({ kind, filename }: { kind: string; filename: string }): Promise<Uint8Array> {
    const folder = folders[kind]
    const load =
      folder && /^[A-Za-z0-9_.-]+$/.test(filename)
        ? assets[`/node_modules/pdfjs-dist/${folder}/${filename}`]
        : undefined
    if (!load) throw new Error('PDF resource is not bundled')
    const url = await load()
    const marker = ';base64,'
    const at = url.indexOf(marker)
    if (!url.startsWith('data:') || at < 0) throw new Error('Invalid bundled PDF resource')
    return Uint8Array.from(atob(url.slice(at + marker.length)), (char) => char.charCodeAt(0))
  }
}
