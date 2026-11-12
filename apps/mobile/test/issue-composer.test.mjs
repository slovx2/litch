import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import { transformSync } from '../../../node_modules/esbuild/lib/main.js'
import { kinds, nodes } from '../../../packages/ui/test/issue-thread-fixture.mjs'

function fixture(kind) {
  const source = transformSync(
    readFileSync(
      new URL('../src/screens/managers/issues/IssueThread.tsx', import.meta.url),
      'utf8',
    ),
    { loader: 'tsx', format: 'cjs', jsx: 'automatic' },
  ).code
  let state = []
  let cursor = 0
  let growing
  let fail = false
  const sent = []
  const element = (type, props) => ({ type, props })
  const module = { exports: {} }
  runInNewContext(source, {
    module,
    require(name) {
      if (name === 'react')
        return {
          useState(initial) {
            const index = cursor++
            if (!(index in state))
              state[index] = typeof initial === 'function' ? initial() : initial
            return [
              state[index],
              (value) => {
                state[index] = value
              },
            ]
          },
          useRef(initial) {
            const index = cursor++
            if (!(index in state)) state[index] = { current: initial }
            return state[index]
          },
        }
      if (name === 'react/jsx-runtime') return { jsx: element, jsxs: element }
      if (name === 'react-native')
        return {
          TextInput: 'input',
          Text: 'text',
          View: 'view',
          StyleSheet: { create: (value) => value },
        }
      if (name.endsWith('/composer/grow'))
        return {
          useGrow(ref, text) {
            growing = { ref, text }
            return { numberOfLines: 1 }
          },
        }
      if (name.endsWith('/i18n')) return { useT: () => (key) => key }
      if (name.endsWith('/theme'))
        return { useTheme: () => ({ c: {}, font: { size: {} }, radius: {}, hit: 44 }) }
      if (name.endsWith('/kit/Icon')) return { IconButton: 'send' }
      return {}
    },
  })
  const props = {
    manager: { deviceId: 'nebula', id: 'manager' },
    issue: { id: 'X-42', kind, revision: 3 },
    commands: {
      async comment(value) {
        if (fail) throw new Error('虚构设备暂时断开')
        sent.push(value)
      },
    },
    disabled: false,
    reason: '',
  }
  let tree
  const render = () => {
    cursor = 0
    tree = module.exports.IssueComposer(props)
  }
  const input = () => nodes(tree).find((node) => node.props?.testID === 'issue-comment-input')
  return {
    render,
    input,
    grow: () => growing,
    sent,
    edit(text) {
      input().props.onChangeText(text)
      render()
    },
    remount() {
      state = []
      render()
    },
    reject(value) {
      fail = value
    },
    async send() {
      await nodes(tree)
        .find((node) => node.props?.testID === 'issue-comment-send')
        .props.onPress()
      // 按钮 void 调用异步提交；等待其成功/失败收尾更新状态。
      await new Promise((resolve) => setImmediate(resolve))
      render()
    },
  }
}

for (const kind of kinds) {
  test(`${kind}：评论增高钩子接收输入与恢复草稿；失败保留，成功清空`, async () => {
    const f = fixture(kind)
    f.render()
    assert.equal(f.input().props.ref, f.grow().ref)
    assert.equal(f.input().props.numberOfLines, 1)
    f.edit('虚构第一行\n虚构第二行\n虚构第三行\n虚构第四行')
    assert.equal(f.grow().text, f.input().props.value)
    const draft = f.input().props.value
    f.remount()
    assert.equal(f.input().props.value, draft)
    assert.equal(f.grow().text, draft, '重新挂载时按已有草稿测量')
    f.reject(true)
    await f.send()
    assert.equal(f.grow().text, draft, '提交失败保持草稿高度')
    f.reject(false)
    await f.send()
    assert.equal(f.sent[0].body, draft)
    assert.equal(f.grow().text, '', '发送后重新测量空输入')
    f.remount()
    assert.equal(f.input().props.value, '', '成功提交后不恢复旧草稿')
  })
}
