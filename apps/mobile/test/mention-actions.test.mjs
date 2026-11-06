import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { transformSync } from '../../../node_modules/esbuild/lib/main.js'

// 直接检查真实嵌套 Text 的事件绑定；React Native 在绑定 onLongPress 后会抑制该次 onPress。
const { code } = transformSync(
  readFileSync(new URL('../src/detail/SessionMentions.tsx', import.meta.url), 'utf8'),
  { loader: 'tsx', format: 'cjs', jsx: 'automatic' },
)

for (const listed of [true, false]) {
  test(`消息中的会话链接长按交给气泡菜单，短按只打开存在的会话：listed=${listed}`, () => {
    const opened = []
    let menus = 0
    const mention = { threadId: 's3', title: 'Pi' }
    const element = (type, props) => ({ type, props })
    const stubs = {
      '@litch/core': {
        keys: { summary: () => 'summary' },
        mentionSegments: () => [{ kind: 'mention', mention }],
      },
      react: { Fragment: 'fragment' },
      'react/jsx-runtime': { jsx: element, jsxs: element, Fragment: 'fragment' },
      'react-native': { Text: 'text' },
      '../shell/services': { useKey: () => (listed ? { id: 's3' } : null) },
      '../ui/theme': { useTheme: () => ({ c: {} }) },
      './context': {
        useTranscript: () => ({ deviceId: 'local', openSession: (id) => opened.push(id) }),
      },
    }
    const module = { exports: {} }
    new Function('require', 'module', 'exports', code)(
      (name) => {
        assert.ok(name in stubs, `未定义的依赖：${name}`)
        return stubs[name]
      },
      module,
      module.exports,
    )
    const tree = module.exports.MentionedText({
      text: '@[Pi]',
      sessions: [mention],
      onLongPress: () => menus++,
    })
    const pill = tree.props.children[0]
    const link = pill.type(pill.props)
    link.props.onLongPress()
    assert.equal(menus, 1)
    assert.deepEqual(opened, [])
    if (listed) {
      link.props.onPress()
      assert.deepEqual(opened, ['s3'])
    } else assert.equal(link.props.onPress, undefined)
  })
}
