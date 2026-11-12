// 执行真实讨论组件，只替换宿主绘制与 hooks 调度；两端回归共用虚构议题。
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { transformSync } from '../../../node_modules/esbuild/lib/main.js'

export const kinds = ['decision', 'suggestion', 'request', 'report', 'ordinary']
export const nodes = (node) =>
  Array.isArray(node)
    ? node.flatMap(nodes)
    : !node || typeof node !== 'object'
      ? []
      : [node, ...nodes(node.props?.children)]

export function threadFixture(platform, kind, options = {}) {
  const path =
    platform === 'desktop'
      ? new URL('../src/manager/issues/IssueThread.tsx', import.meta.url)
      : new URL('../../../apps/mobile/src/screens/managers/issues/IssueThread.tsx', import.meta.url)
  const source = transformSync(readFileSync(path, 'utf8'), {
    loader: 'tsx',
    format: 'cjs',
    jsx: 'automatic',
  }).code
  let cursor = 0
  const state = []
  const element = (type, props) => ({ type, props })
  const bodySlot = {}
  let found = options.found ?? false
  let located = 0
  const modules = {
    react: {
      useState(initial) {
        const index = cursor++
        if (!(index in state)) state[index] = typeof initial === 'function' ? initial() : initial
        return [
          state[index],
          (value) => {
            state[index] = value
          },
        ]
      },
      useEffect() {},
    },
    'react/jsx-runtime': { jsx: element, jsxs: element },
    'react-dom': { createPortal: (children) => element('portal', { children }) },
    'react-native': Object.fromEntries(
      ['View', 'Text', 'Switch', 'TextInput']
        .map((name) => [name, name])
        .concat([['StyleSheet', { create: (styles) => styles }]]),
    ),
    '@react-navigation/native': { useIsFocused: () => true },
  }
  const output = { exports: {} }
  runInNewContext(source, {
    module: output,
    require(name) {
      if (modules[name]) return modules[name]
      if (/appearance|\/i18n$/.test(name)) return { useT: () => (key) => key }
      if (name.endsWith('/theme'))
        return { useTheme: () => ({ c: {}, font: { size: {} }, radius: {} }) }
      if (name.endsWith('/services.tsx'))
        return { useServices: () => ({ channel: { command: async () => {} } }) }
      if (name.endsWith('/discussion-pane.ts'))
        return {
          useDiscussionPane: () => ({
            host: { closest: () => ({ querySelector: () => bodySlot }) },
          }),
        }
      if (name.endsWith('/manager-issue-list.mts'))
        return { managerIssueHead: (issue) => issue, MANAGER_ISSUE_STATUSES: { ordinary: [] } }
      if (name.endsWith('/manager-issue-activity.mts')) return { managerIssueActivity: () => [] }
      if (name.endsWith('/IssueDiscussion.tsx')) return { IssueDiscussion: 'discussion' }
      if (name.endsWith('/BoardMarkdown.tsx')) return { BoardMarkdown: 'markdown' }
      if (name.endsWith('/IssueMarkdown')) return { Markdown: 'markdown' }
      if (name.endsWith('/kit/Icon')) return { Fold: 'fold' }
      return {}
    },
  })
  const props = {
    mode: options.mode ?? 'pane',
    bodyMode: options.bodyMode ?? 'discussion',
    bodyOpen: false,
    manager: { deviceId: 'nebula', id: 'manager' },
    disabled: false,
    reason: '',
    issue: {
      id: 'D-42',
      kind,
      title: '星云索引的更新策略',
      body: '虚构背景正文',
      revision: 1,
      discussion: {
        opened: true,
        comments: [{ id: 'c1', createdAt: 1, author: { kind: 'user' }, body: '虚构讨论消息' }],
        questions: [],
      },
      relations: [],
      timeline: [],
      followUp: { state: options.followUp ?? 'on' },
    },
    quick:
      kind === 'ordinary' ? undefined : element('quick', { children: '虚构背景正文与决策选项' }),
    commands: {},
    postRevision: 1,
    onOpenItem() {},
    onShowBody() {
      located++
      return found
    },
  }
  let tree
  function render() {
    cursor = 0
    tree = output.exports.IssueThread(props)
    return nodes(tree)
  }
  return {
    render,
    original: () =>
      nodes(tree).some(
        (node) => node.props?.['data-issue-original'] || node.props?.testID === 'issue-original',
      ),
    located: () => located,
    reveal() {
      nodes(tree)
        .find(
          (node) =>
            node.props?.['data-act'] === 'discussion-body' ||
            node.props?.testID === 'issue-body-toggle',
        )
        .props[platform === 'desktop' ? 'onClick' : 'onToggle']()
      render()
    },
    setFound(value) {
      found = value
    },
    setBody(value) {
      props.bodyOpen = value
      render()
    },
  }
}
