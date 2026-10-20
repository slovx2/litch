// 认登录表单：给预加载用的几条 DOM 规则。跑在标签的隔离环境里，只读 DOM、不改 DOM（不加属性、不插元素），
// 只往框里填值（点选了候选、交还代理前清空密码框）。
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
export function fillInput(input: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  input.value = value
  input.dispatchEvent(new Event('input', { bubbles: true, composed: true }))
  input.dispatchEvent(new Event('change', { bubbles: true }))
}

const USERNAME_NAME = /user|email|login|account|identifier/i

/** 像不像用户名框（不管看不看得见）：写明 autocomplete 是 username、email 的，email 类型的，名字或编号像的 */
function looksLikeUsername(input: HTMLInputElement): boolean {
  if (input.type === 'password') return false
  const tokens = tokensOf(input)
  if (tokens.includes('username') || tokens.includes('email')) return true
  if (input.type === 'email') return true
  if (!isTextual(input) && input.type !== 'hidden') return false
  return USERNAME_NAME.test(input.name) || USERNAME_NAME.test(input.id)
}

/** 一次提交里的登录信息：用户名、（新）密码、改密码表单里的当前密码 */
export interface Submission {
  username: string
  password: string
  current?: string
}

/**
 * 一次提交（表单里，没有表单就是整个文档）交上去的是什么：
 * - 有值的密码框不止一个：写了 autocomplete="new-password" 的是新密码，别的是当前密码；没写的，两个一样的是
 *   新密码加确认，不一样的是当前、新（三个是当前、新、确认）；
 * - 用户名先找密码框前面看得见的那个，没有就找藏起来的（两步登录的第二页、改密码表单常把它藏着）；
 * - 没有有值的密码框：回 null（是不是两步登录的第一步看 stepUsername）
 */
export function submissionOf(root: ParentNode): Submission | null {
  const inputs = Array.from(root.querySelectorAll('input'))
  const filled = inputs.filter((one) => one.type === 'password' && one.value !== '' && usable(one))
  const first = filled[0]
  if (!first) return null
  const marked = filled.filter((one) => tokensOf(one).includes('new-password'))
  let password = first
  let current: string | undefined
  if (marked[0]) {
    password = marked[0]
    current = filled.find((one) => !marked.includes(one))?.value
  } else if (filled.length >= 2 && filled[1]) {
    const same = filled.length === 2 && first.value === filled[1].value
    if (!same) {
      current = first.value
      password = filled[1]
    }
  }
  const shown = loginFieldsOf(first)?.username?.value ?? ''
  const hidden = inputs.find((one) => one.value !== '' && looksLikeUsername(one))?.value ?? ''
  return {
    username: shown || hidden,
    password: password.value,
    ...(current && current !== password.value ? { current } : {}),
  }
}

/** 两步登录的第一步：没有密码框、只有一个有值的看得见的用户名框；回它的值，不是就回空的 */
export function stepUsername(root: ParentNode): string {
  const inputs = Array.from(root.querySelectorAll('input'))
  if (inputs.some((one) => one.type === 'password')) return ''
  const names = inputs.filter((one) => one.value !== '' && usable(one) && looksLikeUsername(one))
  return names.length === 1 && names[0] ? names[0].value : ''
}
