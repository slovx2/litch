import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import { transformSync } from '../../../node_modules/esbuild/lib/main.js'

function editorFixture(platform) {
  const module = { exports: {} }
  const refs = []
  const effects = []
  const frames = []
  let cursor = 0
  let visible = true
  let stored = ''
  let focused = 0
  const element = (type, props) => ({ type, props })
  runInNewContext(
    transformSync(
      readFileSync(new URL('../src/detail/comments/CommentEditor.tsx', import.meta.url), 'utf8'),
      { loader: 'tsx', format: 'cjs', jsx: 'automatic' },
    ).code,
    {
      module,
      requestAnimationFrame: (work) => {
        frames.push(work)
        return frames.length
      },
      cancelAnimationFrame() {},
      require(name) {
        if (name === 'react/jsx-runtime') return { jsx: element, jsxs: element }
        if (name === 'react')
          return {
            useRef(initial) {
              const at = cursor++
              return (refs[at] ??= { current: initial })
            },
            useState: (initial) => [initial, () => {}],
            useCallback: (work) => work,
            useEffect: (work) => effects.push(work),
          }
        if (name === 'react-native')
          return {
            Platform: { OS: platform },
            StyleSheet: { create: (s) => s },
            View: 'view',
            Text: 'text',
            TextInput: 'input',
            ScrollView: 'scroll',
          }
        if (name.endsWith('/i18n')) return { useT: () => (key) => key }
        if (name.endsWith('/theme')) return { useTheme: () => ({ c: {}, radius: {}, hit: 44 }) }
        if (name.endsWith('/controls')) return { Button: 'button' }
        if (name.endsWith('/overlays')) return { Dialog: 'dialog' }
        throw Error(name)
      },
    },
  )
  const render = () => {
    cursor = 0
    const tree = module.exports.CommentEditor({
      visible,
      index: null,
      quote: '星云引用',
      note: '确认评论',
      onSubmit: (value) => {
        stored = value
      },
      onClose: () => {
        visible = false
      },
      onSaved: () => {
        focused++
      },
    })
    for (const work of effects.splice(0)) work()
    return tree
  }
  const nodes = (n) =>
    Array.isArray(n)
      ? n.flatMap(nodes)
      : n && typeof n === 'object'
        ? [n, ...nodes(n.props?.children)]
        : []
  return {
    render,
    nodes,
    flush: () =>
      frames.splice(0).forEach((work) => {
        work()
      }),
    state: () => ({ stored, focused, visible }),
  }
}

for (const platform of ['ios', 'android']) {
  test(`${platform}：保存后关闭评论窗口再交还焦点，取消不请求焦点`, () => {
    const f = editorFixture(platform)
    const tree = f.render()
    f.nodes(tree)
      .find((n) => n.props?.testID === 'comment-editor:ok')
      .props.onPress()
    assert.equal(f.state().stored, '确认评论')
    assert.equal(f.state().focused, 0)
    const closed = f.render()
    if (platform === 'ios') closed.props.onDismiss()
    f.flush()
    assert.equal(f.state().focused, 1)
    closed.props.onDismiss()
    assert.equal(f.state().focused, 1, '原生重复关闭事件不重复抢焦点')
    const cancelled = editorFixture(platform)
    cancelled.render().props.onClose()
    cancelled.render().props.onDismiss()
    cancelled.flush()
    assert.equal(cancelled.state().focused, 0)
  })
}
