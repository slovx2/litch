import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import { transformSync } from 'esbuild'

test('文件链接失败只显示一个主要原因，诊断默认折叠，复制与关闭位于底部', () => {
  const module = { exports: {} }
  const element = (type, props) => ({ type, props })
  const copied = []
  const sources = {
    react: { useRef: () => ({ current: null }), useEffect: () => {} },
    'react-dom': { createPortal: (node) => node },
    'react/jsx-runtime': { jsx: element, jsxs: element },
    '../app/appearance.ts': { useT: () => (key) => key },
    './FileLinkDetails.tsx': { FileLinkDetails: 'details' },
    './actions.ts': { runFileAction: (...args) => copied.push(args) },
  }
  runInNewContext(
    transformSync(
      readFileSync(new URL('../src/files/FileLinkDialog.tsx', import.meta.url), 'utf8'),
      { loader: 'tsx', format: 'cjs', jsx: 'automatic' },
    ).code,
    { module, document: { body: {} }, require: (name) => sources[name] ?? {} },
  )
  const result = {
    status: 'failed',
    path: '/tmp/nebula/report.md',
    href: '/tmp/nebula/report.md',
    candidates: [],
    attempted: ['/tmp/nebula/report.md'],
    failures: [
      { path: '/tmp/nebula/report.md', reason: 'missing' },
      { path: '/srv/nebula/report.md', reason: 'missing' },
    ],
  }
  let closed = false
  const tree = module.exports.FileLinkDialog({
    result,
    onClose: () => {
      closed = true
    },
    onPick: () => {},
  })
  const [head, body, foot] = tree.props.children
  assert.equal(head.props.children, 'files.link.failed')
  const [reason, , details] = body.props.children
  assert.equal(reason.type, 'p')
  assert.equal(reason.props.children[0], 'files.link.error.missing')
  assert.equal(details.type, 'details')
  assert.equal(details.props.expanded, undefined)
  assert.equal(details.props.copy, false)
  const [copy, close] = foot.props.children
  copy.props.onClick()
  assert.equal(copied[0][0], 'copyFull')
  assert.equal(copied[0][1].path, result.path)
  close.props.onClick()
  assert.equal(closed, true)
})
