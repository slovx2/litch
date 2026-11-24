// 飞书消息转文字：各类消息的文字与附件、@ 占位符、卡片、合并转发、截断。
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  cardText,
  clip,
  expandForward,
  FORWARD_CHILD_LIMIT,
  parseContent,
} from '../src/feishu/content.mjs'

const id = { messageId: 'om_1' }

test('文本：@ 占位符换成名字，长占位符不被短的吃掉', () => {
  const parsed = parseContent('text', '{"text":"@_user_1 和 @_user_10 看一下"}', {
    messageId: 'om_1',
    mentions: [
      { key: '@_user_1', name: '小明' },
      { key: '@_user_10', name: '小红' },
    ],
  })
  assert.equal(parsed.text, '@小明 和 @小红 看一下')
  assert.deepEqual(parsed.attachments, [])
})

test('富文本：标题、链接、@、表情和四类附件', () => {
  const post = parseContent(
    'post',
    {
      zh_cn: {
        title: '周报',
        content: [
          [
            { tag: 'text', text: '进度见' },
            { tag: 'a', text: '这里', href: 'https://example.com/r' },
            { tag: 'at', user_id: 'ou_a', user_name: '小明' },
            { tag: 'emotion', emoji_type: 'SMILE' },
          ],
          [{ tag: 'img', image_key: 'img_1' }],
          [{ tag: 'file', file_key: 'file_1', file_name: '报告.pdf' }],
          [{ tag: 'media', file_key: 'file_2', file_name: '演示.mp4' }],
          [{ tag: 'audio', file_key: 'file_3' }],
        ],
      },
    },
    { messageId: 'om_post' },
  )
  assert.match(post.text, /^周报\n进度见这里\(https:\/\/example\.com\/r\)@小明\[表情\]/)
  assert.match(post.text, /\[文件\] 报告\.pdf/)
  assert.deepEqual(
    post.attachments.map((item) => item.kind),
    ['image', 'file', 'media', 'audio'],
  )
  assert.ok(post.attachments.every((item) => item.resourceMessageId === 'om_post'))
})

test('富文本：没有中文时取任意一种语言', () => {
  const post = parseContent(
    'post',
    { en_us: { title: 'Hi', content: [[{ tag: 'text', text: 'there' }]] } },
    id,
  )
  assert.equal(post.text, 'Hi\nthere')
})

test('单个附件：图片、文件、语音、视频（带封面和时长）', () => {
  const image = parseContent('image', { image_key: 'img_x' }, id)
  assert.equal(image.attachments[0]?.kind, 'image')
  assert.match(image.attachments[0]?.name ?? '', /\.png$/)

  const file = parseContent('file', { file_key: 'file_x', file_name: 'a.xlsx' }, id)
  assert.equal(file.text, '[文件] a.xlsx')
  assert.equal(file.attachments[0]?.fileKey, 'file_x')

  const audio = parseContent('audio', { file_key: 'file_a', duration: 3000 }, id)
  assert.equal(audio.attachments[0]?.kind, 'audio')
  assert.match(audio.text, /（3秒）$/)

  const media = parseContent(
    'media',
    { file_key: 'file_m', file_name: 'v.mp4', image_key: 'img_cover', duration: 65000 },
    id,
  )
  assert.equal(media.attachments[0]?.coverImageKey, 'img_cover')
  assert.match(media.text, /1分5秒/)

  assert.equal(parseContent('file', { file_key: 'file_x' }, id).attachments.length, 0)
})

test('不能下载的类型只留占位', () => {
  const folder = parseContent('folder', { file_name: '资料' }, id)
  assert.equal(folder.text, '[文件夹] 资料（飞书不支持下载）')
  assert.equal(folder.attachments.length, 0)
  assert.equal(parseContent('sticker', { file_key: 'file_s' }, id).text, '[表情包]')
})

test('要回源的类型标出 detail', () => {
  const forward = parseContent('merge_forward', 'Merged and Forwarded Message', id)
  assert.equal(forward.detail, 'merge_forward')
  const card = parseContent(
    'interactive',
    { title: '通知', elements: [[{ tag: 'text', text: '卡片正文' }]] },
    id,
  )
  assert.equal(card.detail, 'interactive')
  assert.equal(card.text, '通知\n卡片正文')
  const chat = parseContent('share_chat', { chat_id: 'oc_x' }, id)
  assert.deepEqual([chat.detail, chat.sharedId, chat.text], ['share_chat', 'oc_x', '[群名片] oc_x'])
  const user = parseContent('share_user', { user_id: 'ou_x' }, id)
  assert.deepEqual([user.detail, user.sharedId], ['share_user', 'ou_x'])
})

test('其他类型都转成一行可读的文字', () => {
  const at = '1700000000000'
  assert.equal(parseContent('hongbao', {}, id).text, '[红包]')
  assert.equal(
    parseContent('location', { name: '会议室', longitude: '1', latitude: '2' }, id).text,
    '[位置] 会议室（1,2）',
  )
  assert.equal(
    parseContent('video_chat', { topic: '周会', start_time: at }, id).text,
    '[视频会议] 周会（2023-11-14 22:13 UTC）',
  )
  assert.match(
    parseContent(
      'todo',
      { summary: { zh_cn: { content: [[{ tag: 'text', text: '写周报' }]] } }, due_time: at },
      id,
    ).text,
    /^\[任务\] 写周报（截止 /,
  )
  assert.equal(
    parseContent('vote', { topic: '去哪', options: ['A', 'B'] }, id).text,
    '[投票] 去哪：A / B',
  )
  assert.match(
    parseContent('calendar', { summary: '评审', start_time: at, end_time: '1700003600000' }, id)
      .text,
    /^\[日程\] 评审（.+ ~ .+）$/,
  )
  assert.equal(
    parseContent(
      'system',
      {
        template: '{from_user} 邀请 {to_chatters} 加入群聊',
        from_user: ['小明'],
        to_chatters: ['小红', '小刚'],
      },
      id,
    ).text,
    '小明 邀请 小红、小刚 加入群聊',
  )
})

test('不认识的类型留占位，不丢', () => {
  assert.equal(
    parseContent('brand_new_type', { a: 1 }, id).text,
    '[不支持的消息类型 brand_new_type]',
  )
})

test('卡片：2.0 结构、1.0 结构和嵌套列', () => {
  assert.equal(
    cardText({
      header: { title: { tag: 'plain_text', content: '标题' } },
      body: {
        elements: [
          { tag: 'markdown', content: '**正文**' },
          {
            tag: 'column_set',
            columns: [{ elements: [{ tag: 'div', text: { tag: 'lark_md', content: '左列' } }] }],
          },
          { tag: 'button', text: { tag: 'plain_text', content: '去看看' } },
        ],
      },
    }),
    '标题\n**正文**\n左列\n去看看',
  )
  assert.equal(
    cardText(JSON.stringify({ elements: [{ tag: 'div', text: { content: '旧版正文' } }] })),
    '旧版正文',
  )
})

test('合并转发：逐条展开，附件挂父消息，卡片用回源文字，超量截断', () => {
  const expanded = expandForward('om_parent', [
    { messageId: 'om_parent', msgType: 'merge_forward', content: '' },
    { messageId: 'om_a', msgType: 'text', content: '{"text":"第一句"}' },
    { messageId: 'om_b', msgType: 'image', content: '{"image_key":"img_b"}' },
    { messageId: 'om_c', msgType: 'interactive', content: '{}', cardText: '卡片内容' },
    { messageId: 'om_d', msgType: 'merge_forward', content: '' },
  ])
  assert.match(expanded.text, /^\[合并转发\]\n1\. 第一句\n2\. \[图片\] /)
  assert.match(expanded.text, /3\. 卡片内容\n4\. \[嵌套的合并转发/)
  assert.equal(expanded.attachments[0]?.resourceMessageId, 'om_parent')

  const many = Array.from({ length: FORWARD_CHILD_LIMIT + 3 }, (_, index) => ({
    messageId: `om_${index}`,
    msgType: 'text',
    content: `{"text":"${index}"}`,
  }))
  assert.match(expandForward('om_p', many).text, /共 53 条，只展开前 50 条/)
  assert.match(expandForward('om_p', []).text, /飞书没有返回内容/)
})

test('超长正文截断并注明原长度', () => {
  const text = clip('字'.repeat(30), 10)
  assert.equal(text, `${'字'.repeat(10)}\n[正文过长，已截断，原文 30 字]`)
})
