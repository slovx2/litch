// 发言内容的拼法：分片、卡片的表格上限、@ 的写法、手写 <at> 打断。
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildTextSpeech,
  chunkCardMarkdown,
  chunkMarkdown,
  neutralizeMentions,
  wantsCard,
} from '../src/feishu/speech.mjs'

const PERSON = { openId: 'ou_alice', name: '示例<成员>' }

test('分片：段落优先，段落太长按行，行太长硬切', () => {
  assert.deepEqual(chunkMarkdown('  短  '), ['短'])
  assert.deepEqual(chunkMarkdown('甲甲\n\n乙乙\n\n丙丙', 6), ['甲甲\n\n乙乙', '丙丙'])
  assert.deepEqual(chunkMarkdown('一行\n二行\n三行', 5), ['一行\n二行', '三行'])
  assert.deepEqual(chunkMarkdown('一二三四五六七', 3), ['一二三', '四五六', '七'])
})

test('卡片：每张最多 5 张表，代码块里的竖线不算表格', () => {
  const table = (index: number) => `| 表${index} | 值 |\n| --- | --- |\n| a | ${index} |`
  const text = Array.from({ length: 7 }, (_, index) => table(index)).join('\n\n')
  const cards = chunkCardMarkdown(text)
  assert.equal(cards.length, 2)
  assert.equal(cards[0]?.match(/\| --- \|/g)?.length, 5)
  assert.equal(cards[1]?.match(/\| --- \|/g)?.length, 2)
  const fenced = `\`\`\`\n${table(1)}\n\`\`\``
  assert.equal(chunkCardMarkdown(`${fenced}\n\n${table(2)}`).length, 1)
  assert.ok(wantsCard(fenced))
  assert.ok(wantsCard(table(3)))
  assert.ok(!wantsCard('普通 | 文字'))
})

test('@ 只放在第一条开头，三种格式各用各的写法；手写的 <at> 被打断', () => {
  assert.equal(neutralizeMentions('<at user_id="all">x</at>'), '<\u200bat user_id="all">x</at>')
  const text = buildTextSpeech('text', `${'字'.repeat(4000)}\n\n后一段`, [PERSON])
  assert.equal(text.parts.length, 2)
  assert.match(
    JSON.parse(text.parts[0]?.content as string).text,
    /^<at user_id="ou_alice">示例&#60;成员&#62;<\/at> /,
  )
  assert.doesNotMatch(JSON.parse(text.parts[1]?.content as string).text, /<at/)
  assert.equal(text.preview[0]?.text?.startsWith('@示例<成员> '), true)

  const post = buildTextSpeech('auto', '你好', [PERSON], '标题')
  assert.equal(post.format, 'post')
  assert.deepEqual(JSON.parse(post.parts[0]?.content as string), {
    zh_cn: {
      title: '标题',
      content: [
        [
          { tag: 'at', user_id: 'ou_alice' },
          { tag: 'md', text: '你好' },
        ],
      ],
    },
  })
  const card = buildTextSpeech('auto', '```\ncode\n```', [PERSON])
  assert.equal(card.format, 'card')
  const body = JSON.parse(card.parts[0]?.content as string)
  assert.equal(body.schema, '2.0')
  assert.match(body.body.elements[0].content, /^<at id=ou_alice><\/at> ```/)
})
