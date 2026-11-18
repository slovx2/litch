// 执行正式消息组件，避免文件卡夹具手工补 deviceId 后掩盖历史消息的传参回归。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import { transformSync } from '../../../node_modules/esbuild/lib/main.js'

const element = (type, props) => ({ type, props })
const nodes = (tree) =>
  Array.isArray(tree)
    ? tree.flatMap(nodes)
    : tree && typeof tree === 'object'
      ? [tree, ...nodes(tree.props?.children)]
      : []

function messages(mobile, item, deviceId) {
  const source = readFileSync(
    new URL(
      mobile ? '../../../apps/mobile/src/detail/cells.tsx' : '../src/transcript/messages.tsx',
      import.meta.url,
    ),
    'utf8',
  )
  const module = { exports: {} }
  const links = []
  const fixture = {
    memo: (fn) => fn,
    useState: (v) => [v, () => {}],
    useRef: () => ({ current: null }),
  }
  runInNewContext(
    transformSync(source + (mobile ? '\nexport { UserAttachments }' : ''), {
      loader: 'tsx',
      jsx: 'automatic',
      format: 'cjs',
    }).code,
    {
      module,
      exports: module.exports,
      require(name) {
        if (name === 'react') return fixture
        if (name === 'react/jsx-runtime') return { jsx: element, jsxs: element }
        if (name === '@litch/core')
          return {
            keys: { item: () => 'item' },
            adjacentAskReply: () => false,
            parseAskReply: () => null,
          }
        if (name === 'react-native')
          return { View: 'view', Text: 'text', StyleSheet: { create: (v) => v } }
        if (name.endsWith('/appearance.ts') || name.endsWith('/i18n'))
          return { useT: () => (key) => key }
        if (name.endsWith('/services.tsx'))
          return {
            useKey: () => item,
            useServices: () => ({ replica: { store: { get: () => item } } }),
          }
        if (name.endsWith('/scroll.ts')) return { usePin: () => () => {} }
        if (name.endsWith('/state.ts')) return { useToggle: () => [true, () => {}] }
        if (name.endsWith('/comments/Cite.tsx')) return { commentsOf: () => null }
        if (name.endsWith('/theme')) return { useTheme: () => ({ c: {}, font: {}, radius: {} }) }
        if (name.endsWith('/context'))
          return {
            useTranscript: () => ({
              deviceId,
              openLink: (url) => links.push(url),
              notify: (message) => links.push(message),
            }),
          }
        if (name.endsWith('/links')) return { fileHref: ({ path }) => path }
        if (name.endsWith('/FileCard.tsx') || name.endsWith('/FileCard'))
          return { FileCard: 'file-card' }
        return {}
      },
    },
  )
  return { ...module.exports, links }
}

for (const deviceId of ['local', 'remote']) {
  for (const steered of [false, true])
    test(`桌面/${deviceId}：${steered ? '插话' : '普通消息'}附件保留设备与会话上下文`, () => {
      const item = {
        kind: 'userMessage',
        text: '附件',
        attachments: [{ kind: 'file', path: '/files/a.xls' }],
      }
      const fixture = messages(false, item, deviceId)
      const tree = fixture.UserMessage({ deviceId, sessionId: 'history', itemId: 'u', steered })
      const attachment = nodes(tree).find((node) => node.type === fixture.UserAttachments)
      assert.equal(attachment.props.deviceId, deviceId)
      assert.equal(attachment.props.sessionId, 'history')
      const card = nodes(fixture.UserAttachments(attachment.props)).find(
        (node) => node.type === 'file-card',
      )
      assert.equal(card.props.deviceId, deviceId)
      assert.equal(card.props.sessionId, 'history')
    })
  test(`手机/${deviceId}：设备副本在会话设备打开；控制端专有路径仍明确提示原电脑`, () => {
    const file = {
      kind: 'file',
      path: '/home/device/.litch/attachments/mabcdefg-abcdefgh-12345678/copy.xls',
    }
    const fixture = messages(true, null, deviceId)
    for (const client of [false, true]) {
      const tree = fixture.UserAttachments({ row: { attachments: [{ ...file, client }] } })
      const card = nodes(tree).find((node) => node.type === 'file-card')
      assert.equal(card.props.deviceId, deviceId)
      card.props.onPress()
      assert.equal(fixture.links.at(-1), client ? 'attachment.desktopRequired' : file.path)
    }
  })
}
