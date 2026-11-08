import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import { transform } from 'esbuild'
import { submitQuestionOnEnter } from '../src/manager/post-presentation.ts'

const compile = async (path) =>
  (
    await transform(readFileSync(new URL(path, import.meta.url), 'utf8'), {
      loader: 'tsx',
      format: 'cjs',
      jsx: 'automatic',
    })
  ).code
const form = await compile('../src/manager/form-submit-keys.ts')
const discussion = await compile('../src/manager/issues/IssueDiscussion.tsx')
const nodes = (n) =>
  Array.isArray(n)
    ? n.flatMap(nodes)
    : !n || typeof n !== 'object'
      ? []
      : [n, ...nodes(n.props?.children)]
const event = (patch = {}) => {
  const nativeEvent = { key: 'Enter', keyCode: 13, isComposing: false, shiftKey: false, ...patch }
  return {
    ...nativeEvent,
    nativeEvent,
    defaultPrevented: false,
    preventDefault() {
      this.defaultPrevented = true
    },
  }
}

test('评论真实组件：Enter 提交、IME/Shift 不发、空白与同步重复提交受保护，失败保留草稿', async () => {
  const slots = []
  let cursor = 0
  const react = {
    useState: (initial) => {
      const at = cursor++
      slots[at] ??= { value: typeof initial === 'function' ? initial() : initial }
      return [
        slots[at].value,
        (v) => {
          slots[at].value = v
        },
      ]
    },
    useRef: (initial) => {
      const at = cursor++
      slots[at] ??= { current: initial }
      return slots[at]
    },
  }
  const output = { exports: {} }
  const jsx = (type, props) => ({ type, props })
  runInNewContext(discussion, {
    module: output,
    require(name) {
      if (name === 'react') return react
      if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx }
      if (name.endsWith('post-presentation.ts')) return { submitQuestionOnEnter }
      if (name.endsWith('appearance.ts')) return { useT: () => (key) => key }
      if (name.endsWith('errors.ts')) return { reasonOf: (error) => error.message }
      return {}
    },
  })
  const calls = []
  let reject
  const props = {
    issue: {
      id: 'X-1',
      discussion: { comments: [], questions: [] },
      timeline: [],
      followUp: { state: 'on' },
    },
    draftKey: 'keyboard-test',
    disabled: false,
    special: false,
    onComment(body) {
      calls.push(body)
      return new Promise((_, fail) => {
        reject = fail
      })
    },
  }
  const render = () => {
    cursor = 0
    return nodes(output.exports.IssueDiscussion(props))
  }
  const input = () => render().find((n) => n.type === 'textarea')
  input().props.onChange({ target: { value: '中文草稿' } })
  for (const patch of [{ shiftKey: true }, { isComposing: true }, { keyCode: 229 }]) {
    const e = event(patch)
    input().props.onKeyDown(e)
    assert.equal(e.defaultPrevented, false)
  }
  assert.equal(calls.length, 0)
  const oldInput = input()
  oldInput.props.onKeyDown(event())
  oldInput.props.onKeyDown(event())
  assert.deepEqual(calls, ['中文草稿'])
  reject(new Error('离线'))
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(input().props.value, '中文草稿')
  assert.ok(render().some((n) => n.props?.role === 'alert'))
  input().props.onChange({ target: { value: '  ' } })
  input().props.onKeyDown(event())
  assert.equal(calls.length, 1)
  props.disabled = true
  input().props.onChange({ target: { value: '离线时不发' } })
  input().props.onKeyDown(event())
  assert.equal(calls.length, 1)
})

test('表单实际 hook：多行/候选/输入法隐式提交与重入', async () => {
  class Input {
    form = 'form'
    value = '标题'
    getAttribute() {
      return null
    }
  }
  class Textarea extends Input {}
  const timers = []
  const output = { exports: {} }
  runInNewContext(form, {
    module: output,
    HTMLInputElement: Input,
    HTMLTextAreaElement: Textarea,
    setTimeout: (run) => timers.push(run),
    require(name) {
      if (name === 'react') return { useRef: (current) => ({ current }) }
      return { submitQuestionOnEnter }
    },
  })
  let calls = 0
  let finish
  const keys = output.exports.useBoardFormKeys(() => {
    calls++
    return new Promise((resolve) => {
      finish = resolve
    })
  })
  const key = (field, patch = {}) => {
    const e = event(patch)
    e.target = field
    e.currentTarget = 'form'
    keys.onKeyDown(e)
    return e
  }
  const title = new Input(),
    body = new Textarea()
  assert.equal(key(body).defaultPrevented, false)
  assert.equal(key(body, { shiftKey: true }).defaultPrevented, false)
  assert.equal(calls, 0)
  keys.onCompositionStart()
  key(title, { isComposing: true })
  keys.onSubmit(event())
  assert.equal(calls, 0)
  keys.onCompositionEnd()
  key(title, { keyCode: 229 })
  keys.onSubmit(event())
  assert.equal(calls, 0)
  while (timers.length) timers.shift()()
  body.value = '  '
  key(body, { ctrlKey: true })
  assert.equal(calls, 0)
  body.value = '正文'
  key(body, { ctrlKey: true })
  key(body, { metaKey: true })
  keys.onSubmit(event())
  assert.equal(calls, 1)
  finish()
  await new Promise((resolve) => setImmediate(resolve))
  const candidate = new Input()
  candidate.getAttribute = (name) => (name === 'role' ? 'combobox' : null)
  key(candidate)
  assert.equal(calls, 1)
  key(candidate, { metaKey: true })
  assert.equal(calls, 2)
  finish()
})
