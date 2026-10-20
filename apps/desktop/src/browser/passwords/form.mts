// 认登录表单：给预加载用的几条 DOM 规则。跑在用户标签的隔离环境里，只读 DOM、不改 DOM（不加属性、不插元素），
// 网页看不出来有它。
//
// 登录框是这几种：
// - 密码框（type=password），注册用的 autocomplete="new-password" 除外；
// - 写明 autocomplete="username" 的框（分两步登录的第一步，只有用户名）；
// - 同一个表单里（没有表单就是整个文档）紧挨在某个密码框前面的那个文字框（text、email、tel，没写类型的也算）。

const TEXTUAL = new Set(['text', 'email', 'tel', ''])

const tokensOf = (input: HTMLInputElement): string[] =>
  (input.getAttribute('autocomplete') ?? '').toLowerCase().split(/\s+/).filter(Boolean)

export const isPasswordInput = (input: HTMLInputElement): boolean =>
  input.type === 'password' && !tokensOf(input).includes('new-password')

const isTextual = (input: HTMLInputElement): boolean =>
  TEXTUAL.has((input.getAttribute('type') ?? '').toLowerCase()) || input.type === 'text'

/** 看得见、能填：不是隐藏的、禁用的、只读的，有大小 */
export function usable(input: HTMLInputElement): boolean {
  if (input.disabled || input.readOnly || !input.isConnected) return false
  const rect = input.getBoundingClientRect()
  if (rect.width < 2 || rect.height < 2) return false
  const style = getComputedStyle(input)
  return style.visibility !== 'hidden' && style.display !== 'none'
}

/** 同一个表单里的输入框，按文档里的先后；不在表单里的按整个文档里不在表单里的 */
function siblingsOf(input: HTMLInputElement): HTMLInputElement[] {
  const scope = input.form
  const all = scope
    ? Array.from(scope.elements).filter(
        (one): one is HTMLInputElement => one instanceof HTMLInputElement,
      )
    : Array.from(input.ownerDocument.querySelectorAll('input')).filter((one) => !one.form)
  return all.filter((one) => one === input || usable(one))
}

/** 密码框前面的那个用户名框 */
function usernameBefore(fields: HTMLInputElement[], password: HTMLInputElement) {
  const at = fields.indexOf(password)
  for (let i = at - 1; i >= 0; i--) {
    const one = fields[i]
    if (!one) continue
    if (one.type === 'password') return null
    if (isTextual(one)) return one
  }
  return null
}

export interface LoginFields {
  username: HTMLInputElement | null
  password: HTMLInputElement | null
}

/** 这个框是不是登录框；是就回它所在登录表单的用户名框和密码框（可能只有其中一个） */
export function loginFieldsOf(target: EventTarget | null): LoginFields | null {
  if (!(target instanceof HTMLInputElement)) return null
  const fields = siblingsOf(target)
  if (isPasswordInput(target)) {
    return { username: usernameBefore(fields, target), password: target }
  }
  if (!isTextual(target)) return null
  const at = fields.indexOf(target)
  // 后面紧接着的第一个密码框（中间隔着别的文字框就不算）
  for (let i = at + 1; i < fields.length; i++) {
    const one = fields[i]
    if (!one) continue
    if (isPasswordInput(one)) return { username: target, password: one }
    if (one.type === 'password' || isTextual(one)) break
  }
  if (tokensOf(target).includes('username')) return { username: target, password: null }
  return null
}

/**
 * 填一个框：用原生的 value 写进去，再发 input 和 change，好让网页的框架（React 之类）知道值变了。
 * 隔离环境里拿到的是原生的 setter，网页改过的 value 属性碰不到这里
 */
export function fillInput(input: HTMLInputElement, value: string): void {
  input.value = value
  input.dispatchEvent(new Event('input', { bubbles: true, composed: true }))
  input.dispatchEvent(new Event('change', { bubbles: true }))
}
