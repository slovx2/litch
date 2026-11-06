import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { mediaBlocks } from '../src/detail/media/segments.ts'

test('手机图片由 AST 提取，代码/HTML/普通链接不触发加载，引用式图片保留', () => {
  const source =
    '![图](<./中文 图.png>)\n\n![ref][image]\n\n[image]: /tmp/x.png\n\n[普通](https://a.test/x.png)\n\n`![代码](x.png)`\n\n```md\n![围栏](x.png)\n```\n\n<img src="https://a.test/x.png">'
  const blocks = mediaBlocks(source)
  assert.deepEqual(
    blocks.flatMap((block) => block.images),
    [
      { href: './中文 图.png', alt: '图' },
      { href: '/tmp/x.png', alt: 'ref' },
    ],
  )
  assert.ok(blocks.some((block) => block.text.includes('![围栏]')))
  assert.ok(blocks.some((block) => block.text.includes('`![代码]')))
  assert.ok(blocks.every((block) => !block.text.includes('![ref]')))
})

test('未闭合图片不读取；列表和表格中的图也由受控组件接管', () => {
  assert.equal(
    mediaBlocks('![图](https://a.test/incomplete').flatMap((block) => block.images).length,
    0,
  )
  const blocks = mediaBlocks('- ![列表](a.png)\n\n| 列 |\n|---|\n| ![表格](b.png) |')
  assert.deepEqual(
    blocks.flatMap((block) => block.images).map((image) => image.href),
    ['a.png', 'b.png'],
  )
  assert.ok(blocks.every((block) => !block.text.includes('![')))
})

test('原生 Markdown 两端封闭 URL 读取旁路，实际补丁纳入安装流程', () => {
  const patch = readFileSync(
    new URL('../patches/react-native-enriched-markdown+1.1.0.patch', import.meta.url),
    'utf8',
  )
  assert.match(patch, /\+ {4}if \(imageUrl\.isNotEmpty\(\)\) return/)
  assert.match(patch, /\+ {2}if \(url\.length > 0\) \{\n\+ {4}completion\(nil\);\n\+ {4}return;/)
})
