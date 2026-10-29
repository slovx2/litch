import ExcelJS from '../node_modules/exceljs/excel.js'
import JSZip from '../node_modules/jszip/lib/index.js'
export const NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
const REL = 'http://schemas.openxmlformats.org/package/2006/relationships'
export async function zipOf(files, compression = 'DEFLATE') {
  const zip = new JSZip()
  for (const [name, content] of Object.entries(files)) zip.file(name, content)
  return zip.generateAsync({ type: 'uint8array', compression })
}
export async function docx(malicious = false) {
  return zipOf({
    '[Content_Types].xml': `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/><Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/></Types>`,
    '_rels/.rels': `<Relationships xmlns="${REL}"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
    'word/document.xml': `<w:document xmlns:w="${NS}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body>
    <w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:rPr><w:b/><w:sz w:val="36"/></w:rPr><w:t>项目报告 · Office 预览</w:t></w:r></w:p>
    <w:p><w:r><w:t>中文段落与 English text。文档保留段落、表格、页眉与页脚。</w:t></w:r></w:p>
    <w:tbl><w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4"/><w:bottom w:val="single" w:sz="4"/></w:tblBorders></w:tblPr><w:tblGrid><w:gridCol w:w="4000"/><w:gridCol w:w="4000"/></w:tblGrid><w:tr><w:tc><w:p><w:r><w:t>项目</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>结果 42</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
    <w:p><w:r><w:drawing><wp:inline><wp:extent cx="914400" cy="914400"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:blipFill><a:blip r:embed="${malicious ? 'external' : 'img1'}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="914400" cy="914400"/></a:xfrm><a:prstGeom prst="rect"/></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>
    ${malicious ? '<w:altChunk r:id="bad"/><w:hyperlink r:id="link"><w:r><w:t>外链不导航</w:t></w:r></w:hyperlink><w:p><w:r><w:t>&lt;script&gt;parent.pwned=true&lt;/script&gt;</w:t></w:r></w:p>' : ''}
    <w:sectPr><w:headerReference w:type="default" r:id="header"/><w:footerReference w:type="default" r:id="footer"/><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1200" w:right="1000" w:bottom="1200" w:left="1000" w:header="500" w:footer="500"/></w:sectPr></w:body></w:document>`,
    'word/header1.xml': `<w:hdr xmlns:w="${NS}"><w:p><w:r><w:t>内部报告 · 页眉</w:t></w:r></w:p></w:hdr>`,
    'word/footer1.xml': `<w:ftr xmlns:w="${NS}"><w:p><w:r><w:t>只读资料 · 页脚</w:t></w:r></w:p></w:ftr>`,
    'word/media/image1.png': Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5xoAAAAASUVORK5CYII=',
      'base64',
    ),
    'word/_rels/document.xml.rels': `<Relationships xmlns="${REL}"><Relationship Id="img1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/><Relationship Id="header" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/><Relationship Id="footer" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/>${malicious ? '<Relationship Id="bad" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/aFChunk" Target="bad.html"/><Relationship Id="link" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" TargetMode="External" Target="javascript:parent.pwned=true"/><Relationship Id="external" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" TargetMode="External" Target="https://office-probe.invalid/external.png"/>' : ''}</Relationships>`,
    ...(malicious
      ? {
          'word/bad.html':
            '<script>parent.pwned=true;fetch("https://office-probe.invalid/")</script><img src="https://office-probe.invalid/pixel"><iframe src="javascript:alert(1)"></iframe>',
        }
      : {}),
  })
}
export async function xlsx({ large = false, date1904 = false } = {}) {
  const book = new ExcelJS.Workbook()
  book.properties.date1904 = date1904
  const sheet = book.addWorksheet('数据表')
  sheet.addRow(['项目', '数值', '备注'])
  sheet.addRow(['中文内容', 42, '001234567890123456789'])
  sheet.addRow(['公式缓存', { formula: 'SUM(40,2)', result: 42 }, '<script>alert(1)</script>'])
  sheet.addRow([
    '无缓存公式',
    { formula: '1+2' },
    { text: '外链作为文字', hyperlink: 'https://office-probe.invalid/xlsx' },
  ])
  sheet.addRow(['日期', new Date('2024-02-29T00:00:00Z'), '闰日'])
  sheet.getCell('B5').numFmt = 'yyyy-mm-dd'
  sheet.addRow(['比例', 0.125])
  sheet.getCell('B6').numFmt = '0.0%'
  sheet.mergeCells('A8:C8')
  sheet.getCell('A8').value = '合并单元格'
  if (large)
    for (let row = 9; row <= 10_000; row++) sheet.getRow(row).values = [`第 ${row} 行`, row, '数据']
  const second = book.addWorksheet('第二张表')
  second.addRow(['另一个工作表', '中文'])
  return new Uint8Array(await book.xlsx.writeBuffer())
}
