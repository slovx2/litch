import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import { transformSync } from 'esbuild'
import { kinds, nodes } from './issue-thread-fixture.mjs'

const source = transformSync(
  readFileSync(new URL('../src/manager/issues/IssueDiscussion.tsx', import.meta.url), 'utf8'),
  { loader: 'tsx', format: 'cjs', jsx: 'automatic' },
).code
function discussion(kind, state) {
  const module = { exports: {} }
  const element = (type, props) => ({ type, props })
  runInNewContext(source, {
    module,
    require(name) {
      if (name === 'react/jsx-runtime') return { jsx: element, jsxs: element }
      if (name === 'react')
        return {
          useContext: () => null,
          useRef: (value) => ({ current: value }),
          useState: (value) => [typeof value === 'function' ? value() : value, () => {}],
        }
      if (name.endsWith('/appearance.ts')) return { useT: () => (key) => key }
      if (name.endsWith('/manager-issue-activity.mts')) return { managerIssueActivity: () => [] }
      return {}
    },
  })
  return nodes(
    module.exports.IssueDiscussion({
      issue: {
        kind,
        followUp: { state },
        discussion: { comments: [], questions: [] },
        timeline: [],
      },
      draftKey: 'nebula',
      disabled: false,
      reason: '',
      special: kind !== 'ordinary',
      onComment: async () => {},
    }),
  )
}
for (const kind of kinds) {
  test(`${kind}：按设备跟进状态显示提示，报告仅显式暂停才提示`, () => {
    assert.equal(
      discussion(kind, 'on').some((node) => node.props?.['data-follow-note']),
      false,
    )
    assert.ok(discussion(kind, 'off').some((node) => node.props?.['data-follow-note'] === true))
  })
}
