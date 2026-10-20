// 交还代理之前查一下：页面里有没有预加载够不着的输入框（封闭的影子树里的）。主进程用 CDP 的
// DOM.getDocument（pierce: true）拿整棵树，这里只看树；有的话清不了，改成重新载入。纯函数，单测在
// test/passwords-signin.test.mts。
export interface DomNode {
  nodeName?: string
  shadowRootType?: string
  children?: DomNode[]
  shadowRoots?: DomNode[]
  contentDocument?: DomNode
}

const FIELDS = new Set(['INPUT', 'TEXTAREA'])

/** 封闭的影子树里有没有输入框（同进程的子框架也一起看） */
export function hasClosedShadowFields(node: DomNode, closed = false): boolean {
  if (closed && FIELDS.has((node.nodeName ?? '').toUpperCase())) return true
  for (const child of node.children ?? []) if (hasClosedShadowFields(child, closed)) return true
  for (const root of node.shadowRoots ?? []) {
    if (hasClosedShadowFields(root, closed || root.shadowRootType === 'closed')) return true
  }
  return node.contentDocument ? hasClosedShadowFields(node.contentDocument, closed) : false
}
