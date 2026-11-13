import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { transform } from 'esbuild'

// 执行真实的两端组件与 effect；只替换绘制和调度，复现同一份未读被重复快照替换的条件。
for (const [platform, path, name] of [
  ['desktop', '../src/manager/issues/IssueCard.tsx', 'IssueCard'],
  [
    'mobile',
    '../../../apps/mobile/src/screens/managers/issues/IssueConsole.tsx',
    'IssueSheetDrawer',
  ],
]) {
  const compiled = await transform(readFileSync(new URL(path, import.meta.url), 'utf8'), {
    loader: 'tsx',
    format: 'cjs',
    jsx: 'automatic',
  })
  for (const fails of [false, true])
    test(`${platform}：${fails ? '超时后' : '慢响应中'}重复快照不重复 seen；新回复和重新打开可再确认`, async () => {
      const slots = []
      let cursor = 0
      let effects = []
      const output = { exports: {} }
      const jsx = (type, props) => ({ type, props })
      const calls = []
      const commands = {
        seen: (p) => {
          calls.push(p)
          return fails ? Promise.reject(new Error('timeout')) : new Promise(() => {})
        },
      }
      const react = {
        useRef: (value) => {
          const i = cursor++
          return (slots[i] ??= { current: value })
        },
        useState: (value) => {
          cursor++
          return [value, () => {}]
        },
        useEffect: (run) => {
          cursor++
          effects.push(run)
        },
      }
      runInNewContext(compiled.code, {
        module: output,
        require: (id) => {
          if (id === 'react') return react
          if (id === 'react/jsx-runtime') return { jsx, jsxs: jsx }
          if (id === 'react-native') return { StyleSheet: { create: (s) => s } }
          if (id.endsWith('/appearance.ts') || id.endsWith('/i18n')) return { useT: () => (k) => k }
          if (id.endsWith('/services')) return { useChannel: () => ({}) }
          if (id.endsWith('/theme')) return { useTheme: () => ({ c: {}, font: { size: {} } }) }
          return {}
        },
      })
      let issue = {
        id: 'X-1',
        kind: 'ordinary',
        title: '',
        revision: 1,
        updatedAt: 10,
        unread: true,
        discussion: { comments: [], questions: [] },
        author: { kind: 'manager' },
        followUp: { state: 'off' },
      }
      function render(enabled = true) {
        cursor = 0
        effects = []
        output.exports[name]({
          manager: {},
          features: { paging: false },
          head: issue,
          issue: structuredClone(issue),
          open: enabled,
          issues: { details: { 'X-1': structuredClone(issue) } },
          issueId: 'X-1',
          commands,
          disabled: !enabled,
        })
        for (const run of effects) run()
      }
      render()
      for (let n = 0; n < 1000; n++) render()
      await Promise.resolve()
      assert.equal(calls.length, 1)
      issue = { ...issue, discussion: { ...issue.discussion, comments: [{ id: 'new-comment' }] } }
      render()
      assert.equal(calls.length, 2, '同秒、同正文版本的新回复仍确认')
      render(false)
      render()
      assert.equal(calls.length, 3, '重新打开或连接恢复后可再确认')
      issue = { ...issue, kind: 'report' }
      render()
      assert.equal(calls.length, 3, '报告仍由已阅操作管理')
      await Promise.resolve()
    })
}
