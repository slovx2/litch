// 手机经理工作台（35-manager 第十七节）：对话里的看板编号链接、工作线回经理的导航、工作线一行的几段字。
import assert from 'node:assert/strict'
import test from 'node:test'
import { linkIssues, parseIssueHref } from '../src/detail/issue-links.ts'
import { lineIssues, managerRouteBelow } from '../src/screens/managers/origin.ts'
import { lineRowParts } from '../src/screens/managers/presentation.ts'

test('分页会话正文未确认编号保持普通文字，代码和路径仍不改写', () => {
  const ids = Object.assign(new Set(), { deferred: true })
  assert.equal(linkIssues('D-60 `D-60` feat/D-60', ids), 'D-60 `D-60` feat/D-60')
})

test('纯逻辑单测阻止引入 React，即使本地安装了手机依赖', async () => {
  await assert.rejects(() => import('react'), /手机纯逻辑单测不能加载 React/)
  await assert.rejects(() => import('react/jsx-runtime'), /手机纯逻辑单测不能加载 React/)
})

test('建议编号可跳转，未知编号和代码中的编号保持原文', () => {
  const source = '#S-abc-def #P-1 #R-1 #I-1 #D-999\n    #P-1\n~~~\n#P-1\n~~~\n```\n#P-1'
  const linked = linkIssues(source, new Set(['S-abc-def', 'P-1', 'R-1', 'I-1']))
  assert.match(linked, /\[#S-abc-def\]\(litch-issue:S-abc-def\)/)
  assert.match(linked, /#D-999\n {4}#P-1\n~~~\n#P-1\n~~~\n```\n#P-1$/)
  assert.equal(linkIssues(source, new Set()), source, '普通会话不改写')
})

test('对话正文的看板编号改成链接：字形不变，只认看板上有的，代码与已有链接不动', () => {
  const ids = new Set(['D-15', 'D-16', 'I-2'])
  assert.equal(
    linkIssues('请看 D-15、#D-16 和 D-99；`D-15` [别处](https://x/D-16) I-2', ids),
    '请看 [D-15](litch-issue:D-15)、[#D-16](litch-issue:D-16) 和 D-99；`D-15` [别处](https://x/D-16) [I-2](litch-issue:I-2)',
  )
  assert.equal(linkIssues('```\nD-15\n```', ids), '```\nD-15\n```', '代码块不动')
  assert.equal(
    linkIssues('AD-15 D-150 feat/D-15', ids),
    'AD-15 D-150 feat/D-15',
    '词中间、路径里不认',
  )
  assert.equal(linkIssues('D-15', new Set()), 'D-15')
  assert.equal(parseIssueHref('litch-issue:D-15'), 'D-15')
  assert.equal(parseIssueHref('https://x'), null)
})

test('工作线回经理：栈里下面有这个经理页就退回那一层，别的经理不算，没有就新推', () => {
  const manager = (key, managerId) => ({
    key,
    name: 'ManagerConsole',
    params: { deviceId: 'local', managerId },
  })
  const detail = (key) => ({ key, name: 'Detail', params: { deviceId: 'local', sessionId: key } })
  const routes = [{ key: 'home', name: 'Devices' }, manager('m1', 'm1'), detail('k1')]
  assert.equal(managerRouteBelow(routes, 2, 'local', 'm1')?.key, 'm1', '紧挨着下面')
  const deep = [...routes, detail('k2'), manager('m2', 'm2'), detail('k3')]
  assert.equal(managerRouteBelow(deep, 5, 'local', 'm1')?.key, 'm1', '更深处')
  assert.equal(managerRouteBelow(deep, 5, 'local', 'm2')?.key, 'm2')
  assert.equal(managerRouteBelow(deep, 5, 'build', 'm1'), null, '别的设备')
  assert.equal(managerRouteBelow([detail('k1')], 0, 'local', 'm1'), null, '栈里没有')
})

test('工作线的相关议题：按来源、派生、相关的顺序合在一起，只要议题，去重', () => {
  const thread = { kind: 'thread', target: 'k1' }
  const edge = (id, from, to, kind = 'derived') => ({ id, from, to, kind, at: 1, by: 'manager' })
  const relations = [
    edge('1', { kind: 'issue', target: 'D-15' }, thread),
    edge('2', thread, { kind: 'issue', target: 'R-1' }),
    edge('3', thread, { kind: 'item', target: 'I-2' }, 'related'),
    edge('4', { kind: 'issue', target: 'D-15' }, thread, 'related'),
    edge('5', { kind: 'issue', target: 'P-1' }, { kind: 'thread', target: 'k2' }),
  ]
  assert.deepEqual(lineIssues(relations, 'k1'), ['R-1', 'D-15'])
})

test('工作线一行：有分支写分支和领先数，没有分支写回报第一句正文；没验单独计数', () => {
  const line = {
    threadId: 'k1',
    title: '回退',
    branch: 'feat/x',
    ahead: 3,
    merged: false,
    report: { text: '**工作线回报**\n\n- 完成原消息编辑', at: 1 },
    unverified: ['没验：手机', '没验：Codex'],
  }
  assert.deepEqual(lineRowParts({ line, state: 'running', at: 1 }), {
    mark: 'running',
    state: 'manager.running',
    branch: 'feat/x +3',
    merged: false,
    report: null,
    unverified: 2,
  })
  const plain = lineRowParts({
    line: { ...line, branch: null, ahead: null, merged: null, unverified: [] },
    state: 'waiting',
    at: 1,
  })
  assert.equal(plain.report, '完成原消息编辑', '跳过加粗的标题行')
  assert.equal(plain.mark, 'waiting')
  assert.equal(lineRowParts({ line: { ...line, merged: true }, state: 'idle', at: 1 }).merged, true)
  assert.equal(lineRowParts({ line, state: 'background', at: 1 }).state, 'mgr.lines.background')
})
