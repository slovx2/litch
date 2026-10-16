import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseSpans, spanText } from '../src/index.mjs'

test('上色的片段：嵌套的片段按层次还原，文字里的转义还原成原文', () => {
  const html =
    '<span class="hljs-keyword">const</span> a = <span class="hljs-string">&quot;x &lt; y &amp;&amp; z&quot;</span>'
  assert.deepEqual(parseSpans(html), [
    { cls: 'hljs-keyword', children: ['const'] },
    ' a = ',
    { cls: 'hljs-string', children: ['"x < y && z"'] },
  ])
  const nested = '<span class="hljs-title function_">f<span class="hljs-params">(a)</span></span>;'
  assert.deepEqual(parseSpans(nested), [
    { cls: 'hljs-title function_', children: ['f', { cls: 'hljs-params', children: ['(a)'] }] },
    ';',
  ])
  assert.equal(spanText(parseSpans(nested)), 'f(a);')
})

test('上色的片段：只认带类名的 span，别的标签一律当文字，不成对的也不出错', () => {
  // 上色库会把原文里的尖括号转义；万一没转义，也只是照字面显示出来
  assert.deepEqual(parseSpans('<img src=x onerror=alert(1)>'), ['<img src=x onerror=alert(1)>'])
  assert.deepEqual(parseSpans('<span onclick="x">a</span>'), ['<span onclick="x">a'])
  assert.deepEqual(parseSpans('a</span>b'), ['a', 'b'])
  assert.deepEqual(parseSpans('<span class="k">没有收尾'), [{ cls: 'k', children: ['没有收尾'] }])
  // 已经转义过的实体只还原一层
  assert.deepEqual(parseSpans('&amp;lt;'), ['&lt;'])
  assert.deepEqual(parseSpans(''), [])
})
