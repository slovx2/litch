// 自建 PDF 安全夹具，无外部 PDF 文件或生成库。恶意动作仅写入文档，验收不得执行。
import { deflateSync } from 'node:zlib'

export function pdfFixture({
  pages = 3,
  encrypted = false,
  huge = false,
  cjk = true,
  longText = false,
  compressedImage = false,
  jpx = false,
} = {}) {
  const objects = []
  const add = (text) => {
    objects.push(Buffer.isBuffer(text) ? text : Buffer.from(text))
    return objects.length
  }
  const stream = (bytes, entries = '') =>
    Buffer.concat([
      Buffer.from(`<< /Length ${bytes.length} ${entries} >>\nstream\n`),
      bytes,
      Buffer.from('\nendstream'),
    ])
  add('') // catalog
  add('') // pages
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
  const chinese = add(
    '<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /UniGB-UCS2-H /DescendantFonts [5 0 R] >>',
  )
  add(
    '<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light /CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 4 >> /FontDescriptor 6 0 R /DW 1000 >>',
  )
  add(
    '<< /Type /FontDescriptor /FontName /STSong-Light /Flags 6 /FontBBox [0 -200 1000 900] /ItalicAngle 0 /Ascent 900 /Descent -200 /CapHeight 800 /StemV 80 >>',
  )
  const action = add(
    '<< /S /JavaScript /JS (globalThis.__pdfScriptExecuted = true; app.launchURL("https://pdf.invalid/script");) >>',
  )
  const link = add(
    '<< /Type /Annot /Subtype /Link /Rect [40 40 300 100] /A << /S /URI /URI (https://pdf.invalid/link) >> >>',
  )
  const imageSize = jpx ? 32 : compressedImage ? 4000 : 64
  const pixels = Buffer.alloc(imageSize * imageSize * 3, 160)
  if (!compressedImage)
    for (let i = 0; i < pixels.length; i += 3) {
      pixels[i] = (i / 3) % 256
      pixels[i + 2] = 80
    }
  // 自建 32×32 灰色位图经 sips 编码，保留裸 JPEG2000 数据流（不含工具附加的 ICC 资料）。
  const jp2 = Buffer.from(
    '/0//UQAvAAAAAAAgAAAAIAAAAAAAAAAAAAAAIAAAACAAAAAAAAAAAAADBwEBBwEBBwEB/1IADAAAAAEBBQQEAAD/XAAjIncedup26na8bwBvAG7iZ0xnTGdkUANQA1BFV9JX0ldh/2QAEQABS2FrYWR1LXY1LjIuMf+QAAoAAAAAACQAAf+Tx94ECICAgICAgICAgICAgICAgICAgP/Z',
    'base64',
  )
  const image = add(
    stream(
      jpx ? jp2 : deflateSync(pixels),
      `/Type /XObject /Subtype /Image /Width ${imageSize} /Height ${imageSize} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /${jpx ? 'JPXDecode' : 'FlateDecode'}`,
    ),
  )
  const children = []
  for (let index = 0; index < pages; index++) {
    const title = `BT /F1 24 Tf 40 710 Td (Litch PDF preview - page ${index + 1}) Tj ET\n`
    const chineseText = cjk ? 'BT /F2 24 Tf 40 650 Td <4e2d658765874ef6988489c8> Tj ET\n' : ''
    const repeated = longText ? `BT /F1 0.001 Tf 0 20 Td (${'.'.repeat(100_001)}) Tj ET\n` : ''
    const contents = add(
      stream(Buffer.from(`${title}${chineseText}${repeated}q 240 0 0 180 40 420 cm /Im1 Do Q\n`)),
    )
    const edge = huge ? 30_000 : 600
    const page = add(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${edge} 800] /Rotate ${index === 1 ? 90 : 0} /Resources << /Font << /F1 ${font} 0 R /F2 ${chinese} 0 R >> /XObject << /Im1 ${image} 0 R >> >> /Contents ${contents} 0 R /Annots [${link} 0 R] /AA << /O ${action} 0 R >> >>`,
    )
    children.push(`${page} 0 R`)
  }
  const encryption = encrypted
    ? add(
        '<< /Filter /Standard /V 1 /R 2 /Length 40 /O <' +
          '00'.repeat(32) +
          '> /U <' +
          '00'.repeat(32) +
          '> /P -4 >>',
      )
    : null
  objects[0] = Buffer.from(`<< /Type /Catalog /Pages 2 0 R /OpenAction ${action} 0 R >>`)
  objects[1] = Buffer.from(`<< /Type /Pages /Count ${pages} /Kids [${children.join(' ')}] >>`)
  const parts = [Buffer.from('%PDF-1.7\n')],
    offsets = [0]
  let length = parts[0].length
  for (const [index, object] of objects.entries()) {
    offsets.push(length)
    const part = Buffer.concat([
      Buffer.from(`${index + 1} 0 obj\n`),
      object,
      Buffer.from('\nendobj\n'),
    ])
    parts.push(part)
    length += part.length
  }
  parts.push(
    Buffer.from(
      `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets
        .slice(1)
        .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
        .join(
          '',
        )}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R ${encryption ? `/Encrypt ${encryption} 0 R /ID [<00112233445566778899aabbccddeeff> <00112233445566778899aabbccddeeff>]` : ''} >>\nstartxref\n${length}\n%%EOF\n`,
    ),
  )
  return Buffer.concat(parts)
}
