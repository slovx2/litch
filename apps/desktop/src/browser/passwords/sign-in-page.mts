// Litch 代填在网页这一侧做的事（预加载 preload.mts 调，跑在标签的隔离环境里，各框架一份）：
// 认登录表单（以 form.mts 的规则为准，代理给的编号提示只当辅助）、看得见不、填、聚焦、提交的兜底、
// 落定后的清框与自检。主进程按步骤一条一条请（handover.mts 经 sign-in-fill.mts），这里只回状态，不回任何值。
//
// 编号提示：主进程在冻结之前经 CDP 给代理指的元素加了一次性的 data-litch-sign-in 属性（值是口令加角色），
// 这里第一次查看时找出来、记住、去掉属性。提示的元素必须落在认出的那个登录表单里：用户名提示必须是同一个
// 表单里的文字框，密码提示必须是 type=password，按钮必须在同一个表单里（没有表单的，在登录框最近的公共容器里），
// 否则算 invalid。

import {
  HINT_ATTRIBUTE,
  type LoginReport,
  type SecretProbe,
  SHORT_SECRET,
  secretFinder,
} from './fill-rules.mjs'
import {
  fillInput,
  isPasswordInput,
  type LoginFields,
  loginFieldsOf,
  looksLikeUsername,
  usable,
} from './form.mjs'

type Field = HTMLInputElement | HTMLTextAreaElement

/** 一次代填在这个框架里认出的东西；清框自检之后丢掉 */
interface Session {
  token: string
  fields: LoginFields
  submit: HTMLElement | null
  /** 认出的表单已经交过一次（回车、点按钮引起的 submit 事件）：兜底的 requestSubmit 不再交第二次 */
  submitted: boolean
}

let session: Session | null = null

// 记下认出的表单交没交过（网页拦下 submit 自己发请求的单页应用也算交过）
window.addEventListener(
  'submit',
  (event) => {
    const field = session?.fields.password ?? session?.fields.username
    if (
      session &&
      field &&
      event.target instanceof HTMLFormElement &&
      event.target === field.form
    ) {
      session.submitted = true
    }
  },
  true,
)

/** 正在代填：这期间的登录提交不出保存提示（preload.mts 的 capture 看它） */
export const signingIn = (): boolean => session !== null

/** 文档和开放的影子树里的元素，按文档先后 */
function deepAll(root: Document | ShadowRoot, selector: string): Element[] {
  const found: Element[] = []
  const walk = (scope: Document | ShadowRoot) => {
    found.push(...Array.from(scope.querySelectorAll(selector)))
    for (const element of Array.from(scope.querySelectorAll('*'))) {
      if (element.shadowRoot) walk(element.shadowRoot)
    }
  }
  walk(root)
  return found
}

const inputs = (): HTMLInputElement[] =>
  deepAll(document, 'input').filter(
    (one): one is HTMLInputElement => one instanceof HTMLInputElement,
  )

/** 一个框属于哪个登录表单：表单本身，没有表单的是它所在的根（文档或影子树） */
const scopeOf = (input: HTMLInputElement): Node => input.form ?? input.getRootNode()

const OTP_NAME = /otp|totp|2fa|mfa|one.?time|verification.?code|security.?code|passcode|sms.?code/i

/** 页面上有没有看得见的验证码、二次验证的框 */
function hasOtp(): boolean {
  return inputs().some((one) => {
    if (!usable(one)) return false
    const tokens = (one.getAttribute('autocomplete') ?? '').toLowerCase()
    return tokens.includes('one-time-code') || OTP_NAME.test(one.name) || OTP_NAME.test(one.id)
  })
}

/** 取出来的提示：同一个口令再查看时（出卡片时预检一遍、开始填之前再一遍）用同一份 */
let hintCache: { token: string; hints: Map<string, Element> } | null = null

/** 取出主进程加的提示并去掉属性 */
function takeHints(token: string | null): Map<string, Element> {
  if (token === null) return new Map()
  if (hintCache?.token === token) return hintCache.hints
  const hints = new Map<string, Element>()
  hintCache = { token, hints }
  for (const element of deepAll(document, `[${HINT_ATTRIBUTE}]`)) {
    const value = element.getAttribute(HINT_ATTRIBUTE) ?? ''
    const at = value.lastIndexOf(':')
    if (value.slice(0, at) !== token) continue
    element.removeAttribute(HINT_ATTRIBUTE)
    hints.set(value.slice(at + 1), element)
  }
  return hints
}

const BUTTON =
  'button, input[type="submit"], input[type="image"], input[type="button"], [role="button"]'

/** 几个元素最近的公共祖先 */
function commonAncestor(nodes: Node[]): Node | null {
  const [first, ...rest] = nodes
  if (!first) return null
  let candidate: Node | null = first
  while (candidate && !rest.every((one) => candidate?.contains(one))) {
    candidate = candidate.parentNode
  }
  return candidate
}

/** 按钮和登录框在不在同一个表单里（没有表单的，在登录框最近的公共容器的上一层以内，且不是整个页面） */
function sameForm(button: Element, fields: HTMLInputElement[]): boolean {
  const form = fields[0]?.form ?? null
  if (form) {
    const owner = button instanceof HTMLButtonElement || button instanceof HTMLInputElement
    return owner ? (button as HTMLButtonElement).form === form : form.contains(button)
  }
  const near = commonAncestor(fields)
  const container = near instanceof Element ? (near.parentElement ?? near) : null
  if (!container || container === document.body || container === document.documentElement) {
    return false
  }
  return container.contains(button)
}

/** 有大小、不透明、不在页面外、中心点上取到的就是它自己（防盖一层透明的东西） */
function visibleToUser(element: HTMLElement): boolean {
  if (element instanceof HTMLInputElement && !usable(element)) return false
  for (let node: Element | null = element; node; node = node.parentElement) {
    const style = getComputedStyle(node)
    if (Number.parseFloat(style.opacity) < 0.1) return false
    if (style.visibility === 'hidden' || style.display === 'none') return false
  }
  element.scrollIntoView({ block: 'center', inline: 'center' })
  const rect = element.getBoundingClientRect()
  if (rect.width < 2 || rect.height < 2) return false
  if (rect.bottom + window.scrollY < 0 || rect.right + window.scrollX < 0) return false
  const x = rect.left + rect.width / 2
  const y = rect.top + rect.height / 2
  if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) return false
  const root = element.getRootNode() as Document | ShadowRoot
  const hit = root.elementFromPoint(x, y)
  if (!hit) return false
  if (hit === element || element.contains(hit)) return true
  return hit instanceof HTMLLabelElement && hit.control === element
}

/**
 * 认这个框架里的登录表单。hintToken 是主进程加提示时用的口令（没有提示是 null）。begin 为真时开一次代填
 * （记下认出的框，之后的填、聚焦、提交按 token 找；出卡片时的预检不开，免得人自己登录时不出保存提示）。
 * 回报告，不回值
 */
export function probeLogin(token: string, hintToken: string | null, begin: boolean): LoginReport {
  const hints = takeHints(hintToken)
  const hinted = hints.size > 0
  const report = (form: LoginReport['form'], extra: Partial<LoginReport> = {}): LoginReport => ({
    form,
    hint: hinted ? 'ok' : 'none',
    visible: false,
    method: null,
    action: null,
    otp: hasOtp(),
    ...extra,
  })
  const all = inputs()
  const passwords = all.filter((one) => isPasswordInput(one) && usable(one))
  const hintPassword = hints.get('password')
  const hintUsername = hints.get('username')
  const hintSubmit = hints.get('submit')
  let password: HTMLInputElement | null = null
  let username: HTMLInputElement | null = null
  if (hintPassword) {
    if (!(hintPassword instanceof HTMLInputElement) || !passwords.includes(hintPassword)) {
      return report('login', { hint: 'invalid' })
    }
    password = hintPassword
  } else if (passwords.length > 0) {
    const scopes = new Set(passwords.map(scopeOf))
    if (scopes.size > 1 && !hintUsername) return report('ambiguous')
    password =
      (hintUsername instanceof HTMLInputElement
        ? passwords.find((one) => scopeOf(one) === scopeOf(hintUsername))
        : passwords[0]) ?? null
    if (!password) return report('login', { hint: 'invalid' })
  }
  if (password) {
    username = loginFieldsOf(password)?.username ?? null
    if (hintUsername) {
      const ok =
        hintUsername instanceof HTMLInputElement &&
        scopeOf(hintUsername) === scopeOf(password) &&
        hintUsername.type !== 'password' &&
        looksTextual(hintUsername)
      if (!ok) return report('login', { hint: 'invalid' })
      username = hintUsername
    }
  } else {
    // 两步登录的第一步：没有密码框，只有一个看得见的用户名框
    const names = all.filter((one) => usable(one) && looksLikeUsername(one))
    if (hintUsername) {
      if (!(hintUsername instanceof HTMLInputElement) || !names.includes(hintUsername)) {
        return report(names.length > 0 ? 'username' : 'none', { hint: 'invalid' })
      }
      username = hintUsername
    } else if (names.length === 1) username = names[0] ?? null
    else if (names.length > 1) return report('ambiguous')
    if (!username) return report('none')
  }
  const fields = [username, password].filter((one): one is HTMLInputElement => one !== null)
  let submit: HTMLElement | null = null
  if (hintSubmit) {
    const button = hintSubmit.closest(BUTTON)
    if (!(button instanceof HTMLElement) || !sameForm(button, fields)) {
      return report(password ? 'login' : 'username', { hint: 'invalid' })
    }
    submit = button
  }
  const form = fields[0]?.form ?? null
  const visible = fields.every(visibleToUser) && (submit === null || visibleToUser(submit))
  if (begin) session = { token, fields: { username, password }, submit, submitted: false }
  return report(password ? 'login' : 'username', {
    visible,
    // 没写 method 的（单页应用常这样，提交由脚本拦下）报 default，只有写明 get 的算用 GET 交
    method: form ? (form.getAttribute('method')?.toLowerCase() ?? 'default') : null,
    action: form ? form.action : null,
  })
}

const looksTextual = (input: HTMLInputElement) =>
  ['text', 'email', 'tel', ''].includes((input.getAttribute('type') ?? '').toLowerCase()) ||
  input.type === 'text'

const current = (token: string): Session | null => (session?.token === token ? session : null)

/**
 * 填进认出的框（给了哪个填哪个；密码只填进 type=password 的框）。回哪些框没填上
 * （网页把值改回去了：要主进程对聚焦的框用真的输入再填一次）
 */
export function fillLogin(
  token: string,
  values: { username?: string; password?: string },
): { ok: boolean; retype: Array<'username' | 'password'> } {
  const one = current(token)
  if (!one) return { ok: false, retype: [] }
  const retype: Array<'username' | 'password'> = []
  const put = (which: 'username' | 'password', field: HTMLInputElement | null, value?: string) => {
    if (value === undefined) return true
    if (!field?.isConnected || !usable(field)) return false
    if (which === 'password' && field.type !== 'password') return false
    fillInput(field, value)
    if (field.value !== value) retype.push(which)
    return true
  }
  const ok =
    put('username', one.fields.username, values.username) &&
    put('password', one.fields.password, values.password)
  return { ok, retype }
}

/** 聚焦一个框并选中里面的字（主进程接着用真的输入替换）；submit 是聚焦按钮，回它中心点在框架里的位置 */
export function focusField(
  token: string,
  which: 'username' | 'password' | 'submit',
): { ok: boolean; point: { x: number; y: number } | null } {
  const one = current(token)
  const element =
    which === 'submit'
      ? one?.submit
      : which === 'username'
        ? one?.fields.username
        : one?.fields.password
  if (!element?.isConnected) return { ok: false, point: null }
  element.focus()
  if (element instanceof HTMLInputElement) element.select()
  const rect = element.getBoundingClientRect()
  return { ok: true, point: { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } }
}

/** 回车没交上去时的兜底：表单的 requestSubmit()。已经交过回 true；没有表单回 false */
export function requestSubmit(token: string): boolean {
  const one = current(token)
  if (one?.submitted) return true
  const field = one?.fields.password ?? one?.fields.username
  const form = field?.isConnected ? field.form : null
  if (!form) return false
  try {
    form.requestSubmit()
    return true
  } catch {
    return false
  }
}

/** 两步登录：认出的用户名框还在不在、密码框出来了没有（同一个文档里换出来的） */
export function hasPasswordField(): boolean {
  return inputs().some((one) => isPasswordInput(one) && usable(one))
}

/**
 * 落定后清框、自检：清空所有密码框（还有 also 说要清的），再查这个框架里还有没有那串密码。
 * 密码短于 SHORT_SECRET 时只查输入框的值。查完这一次代填在这个框架里的东西都丢掉
 */
export function scrub(
  probe: SecretProbe,
  also: (field: Field) => boolean,
): { clean: boolean; cleared: number; loginForm: boolean; otp: boolean } {
  const has = secretFinder(probe)
  const loginForm = hasPasswordField()
  const otp = hasOtp()
  let cleared = 0
  const fields = deepAll(document, 'input, textarea').filter(
    (one): one is Field => one instanceof HTMLInputElement || one instanceof HTMLTextAreaElement,
  )
  // 填过密码的框（网页把它改成了 text 的也算）
  const filled = session?.fields.password ?? null
  for (const field of fields) {
    if (field.value === '') continue
    const secret = field instanceof HTMLInputElement && field.type === 'password'
    if (secret || field === filled || also(field)) {
      fillInput(field, '')
      cleared++
    }
  }
  session = null
  hintCache = null
  let clean = fields.every((field) => !has(field.value))
  if (clean && probe.length >= SHORT_SECRET) clean = !pageHas(has)
  return { clean, cleared, loginForm, otp }
}

/** 页面文字、元素属性、标题、地址、本源的 localStorage 和 sessionStorage 里有没有 */
function pageHas(has: (text: string) => boolean): boolean {
  if (has(document.title)) return true
  const href = location.href
  if (has(href)) return true
  try {
    if (has(decodeURIComponent(href))) return true
  } catch {
    // 解不开的地址只查原样
  }
  if (has(document.documentElement?.textContent ?? '')) return true
  for (const element of deepAll(document, '*')) {
    for (const attribute of Array.from(element.attributes)) if (has(attribute.value)) return true
    if (element.shadowRoot && has(element.shadowRoot.textContent ?? '')) return true
  }
  for (const pick of [() => window.localStorage, () => window.sessionStorage]) {
    let storage: Storage
    try {
      storage = pick()
    } catch {
      continue
    }
    try {
      for (let i = 0; i < storage.length; i++) {
        const key = storage.key(i) ?? ''
        if (has(key) || has(storage.getItem(key) ?? '')) return true
      }
    } catch {
      // 读不了的存储网页自己也读不了
    }
  }
  return false
}
