// 模拟器验收用真实文件；写到 SSH 夹具自己的临时工作目录，不碰用户文件。
import { closeSync, ftruncateSync, mkdirSync, openSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { crc32, deflateSync } from 'node:zlib'

export function samplePng(width = 320, height = 240) {
  const chunk = (name, bytes) => {
    const body = Buffer.concat([Buffer.from(name), bytes])
    const head = Buffer.alloc(4),
      tail = Buffer.alloc(4)
    head.writeUInt32BE(bytes.length)
    tail.writeUInt32BE(crc32(body))
    return Buffer.concat([head, body, tail])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 2
  const pixels = Buffer.alloc((width * 3 + 1) * height)
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const at = y * (width * 3 + 1) + 1 + x * 3
      pixels[at] = x < width / 2 ? 220 : 30
      pixels[at + 1] = y < height / 2 ? 130 : 210
      pixels[at + 2] = 80
    }
  return Buffer.concat([
    Buffer.from('\x89PNG\r\n\x1a\n', 'binary'),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(pixels)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

export function samplePdf(pages = 2, width = 400) {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Count ${pages} /Kids [${Array.from({ length: pages }, (_, i) => `${4 + i * 2} 0 R`).join(' ')}] >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  for (let i = 0; i < pages; i++) {
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} 500] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`,
    )
    const content = `0.1 0.4 0.7 rg 30 30 180 300 re f BT /F1 24 Tf 30 440 Td (Litch preview - Page ${i + 1}) Tj ET`
    objects.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`)
  }
  let result = '%PDF-1.7\n'
  const offsets = [0]
  for (const [i, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(result))
    result += `${i + 1} 0 obj\n${object}\nendobj\n`
  }
  const xref = Buffer.byteLength(result)
  result += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`
  result += offsets
    .slice(1)
    .map((n) => `${String(n).padStart(10, '0')} 00000 n \n`)
    .join('')
  result += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(result)
}

export function writePreviewFixtures(root) {
  const dir = join(root, 'preview')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'a-image.png'), samplePng())
  writeFileSync(join(dir, 'b-pages.pdf'), samplePdf())
  for (const name of ['c-large.png', 'd-large.pdf']) {
    const fd = openSync(join(dir, name), 'w')
    ftruncateSync(fd, name.endsWith('.pdf') ? 21 * 1024 * 1024 : 9 * 1024 * 1024)
    closeSync(fd)
  }
  writeFileSync(join(dir, 'e-broken.png'), 'broken PNG')
  writeFileSync(join(dir, 'f-broken.pdf'), '%PDF-1.7\nbroken')
  writeFileSync(
    join(dir, 'g-pixels.png'),
    samplePng().map((byte, i) => (i === 16 ? 1 : byte)),
  )
  writeFileSync(join(dir, 'h-pages.pdf'), samplePdf(201))
  writeFileSync(join(dir, 'i-size.pdf'), samplePdf(1, 21000))
  writeFileSync(join(dir, 'j-unsupported.docx'), 'not rendered')
  writeFileSync(
    join(dir, 'k-source.svg'),
    '<svg xmlns="http://www.w3.org/2000/svg"><text>SVG source</text></svg>',
  )
  return dir
}
