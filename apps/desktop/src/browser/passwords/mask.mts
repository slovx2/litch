// 代理读不到密码框里的值：litch_browser 的读页工具（snapshot 的无障碍树、type 之后回报的框里的值、
// evaluate 的结果）在交给模型之前经过这里。纯函数，单元测试在 test/passwords-mask.test.mts。
//
// “密码框”指 type=password 的框，以及 autocomplete 写明 current-password、new-password、one-time-code 的框
// （人点了“显示密码”之后框成了 text，这类网页多半写着 autocomplete）。
// 能挡住的：密码框的值不出现在快照里，type 不回报它，evaluate 的结果里原样出现的
// 密码框的值（含 JSON 转义过的写法）换成遮罩。挡不住的：脚本故意把值变换之后再交回来（编码、拆字）；
// 但代理的标签从不自动填充，那里密码框里的字只会是有人当场输进去的。
import type { AxNode } from '../ax.mjs'

/** autocomplete 里有这几个词的框按密码框对待 */
const SECRET_TOKENS = ['current-password', 'new-password', 'one-time-code']

/** 页面里的脚本用的同一条规则：el 是不是密码框 */
const SECRET_JS = `((el) => el instanceof HTMLInputElement && (el.type === 'password' || /(^|\\s)(current-password|new-password|one-time-code)(\\s|$)/i.test(String(el.autocomplete || ''))))`

/** 遮住的值显示成这个 */
export const MASKED = '••••••'

/** 比这短的值不去结果里替换：一两个字到处都是，替了会把正常的结果改坏 */
const REDACT_MIN = 3

/** 可能装着输入值的角色：这些节点要查一下是不是密码框 */
const FIELD_ROLES = new Set(['textbox', 'searchbox', 'combobox', 'textField', 'TextField'])

/** 快照里要问一下 DOM 是不是密码框的节点（backendNodeId） */
export function fieldNodes(nodes: readonly AxNode[]): number[] {
  const out: number[] = []
  for (const node of nodes) {
    if (node.backendDOMNodeId === undefined) continue
    const role = typeof node.role?.value === 'string' ? node.role.value : ''
    const value = node.value?.value
    if (FIELD_ROLES.has(role) || (typeof value === 'string' && value !== '')) {
      out.push(node.backendDOMNodeId)
    }
  }
  return out
}

/** DOM.describeNode 回来的节点是不是密码框 */
export function isPasswordNode(node: { nodeName?: string; attributes?: string[] }): boolean {
  if ((node.nodeName ?? '').toUpperCase() !== 'INPUT') return false
  const attributes = node.attributes ?? []
  for (let i = 0; i + 1 < attributes.length; i += 2) {
    const name = (attributes[i] ?? '').toLowerCase()
    const value = (attributes[i + 1] ?? '').trim().toLowerCase()
    if (name === 'type' && value === 'password') return true
    if (name === 'autocomplete' && value.split(/\s+/).some((one) => SECRET_TOKENS.includes(one)))
      return true
  }
  return false
}

/**
 * 把密码框的值换成遮罩，它下面的子节点（输入框里的文字节点）不要了。
 * 回一份新的节点表，原来的不动
 */
export function maskAxNodes(nodes: readonly AxNode[], secret: ReadonlySet<number>): AxNode[] {
  if (secret.size === 0) return [...nodes]
  return nodes.map((node) => {
    if (node.backendDOMNodeId === undefined || !secret.has(node.backendDOMNodeId)) return node
    const { value, ...rest } = node
    const hasValue =
      typeof value?.value === 'string' ? value.value !== '' : value?.value !== undefined
    return { ...rest, ...(hasValue ? { value: { value: MASKED } } : {}), childIds: [] }
  })
}

/** 在页面里收集密码框现在的值：主文档、同源的子框架、开放的影子树 */
export const COLLECT_PASSWORDS = `(() => {
  const out = []
  const walk = (root) => {
    for (const el of root.querySelectorAll('*')) {
      if (${SECRET_JS}(el) && el.value) out.push(el.value)
      if (el.shadowRoot) walk(el.shadowRoot)
      if (el.tagName === 'IFRAME' || el.tagName === 'FRAME') {
        try { if (el.contentDocument) walk(el.contentDocument) } catch {}
      }
    }
  }
  try { walk(document) } catch {}
  return out
})()`

/** 把结果里原样出现的密码框的值（和它 JSON 转义过的写法）换成遮罩 */
export function redactSecrets(text: string, secrets: readonly unknown[]): string {
  const forms = new Set<string>()
  for (const secret of secrets) {
    if (typeof secret !== 'string' || secret.length < REDACT_MIN) continue
    forms.add(secret)
    const escaped = JSON.stringify(secret).slice(1, -1)
    if (escaped.length >= REDACT_MIN) forms.add(escaped)
  }
  let out = text
  // 长的先替：一个值是另一个的一部分时不留半截
  for (const form of [...forms].sort((a, b) => b.length - a.length)) {
    out = out.split(form).join(MASKED)
  }
  return out
}

/** type 之后读框里的值用的函数：密码框只回遮罩 */
export const READ_FIELD_VALUE = `function () {
  if (${SECRET_JS}(this)) return this.value ? ${JSON.stringify(MASKED)} : ''
  return 'value' in this ? String(this.value) : (this.innerText || '')
}`
