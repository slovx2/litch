// 建会话时带的客户端工具定义（packages/protocol/src/client-tools-specs.mts）要过原生 codex 的校验：
// 不过的话 codex 整个拒绝 thread/start，Litch 在 Codex 上一个会话都建不成（0.8.0 就这样，命名空间说明超长）。
// 规矩只有一份，照上游逐条抄在 packages/shared/test/codex-params.mts（validate_dynamic_tools 连同参数结构的整理与反序列化）；
// 核心真的发出去的整份参数（连同工具定义）在 codex-params.test.mts 里核对，真的对着 codex 走一遍在
// scripts/check-client-tools-codex.mjs 和 apps/desktop/scripts/check-first-turn.mjs。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CLIENT_TOOL_NAMESPACE } from '../../protocol/src/client-tools.mjs'
import {
  SIGN_IN_FILL_FAILURES,
  type SignInFillFailure,
  signInResult,
} from '../../protocol/src/client-tools-browser.mjs'
import { clientToolSpecs } from '../../protocol/src/client-tools-specs.mjs'
import { dynamicToolProblems } from '../../shared/test/codex-params.mjs'

const specs = clientToolSpecs(Object.values(CLIENT_TOOL_NAMESPACE))

test('每个命名空间都有定义', () => {
  assert.deepEqual(
    specs.map((spec) => spec.name),
    Object.values(CLIENT_TOOL_NAMESPACE),
  )
})

test('过得了原生 codex 的校验', () => {
  assert.deepEqual(dynamicToolProblems(specs), [])
})

test('每个工具的参数最外层是对象', () => {
  // 守的是模型接口（OpenAI、Anthropic 的函数调用都要求参数是对象）的要求，不是 codex 的：codex 的整理
  // 对最外层不是对象的结构不报错（没有类型提示的会被清空），过得了上面那一条也照样会让模型那一头出错
  for (const spec of specs)
    for (const tool of spec.tools)
      assert.equal(tool.inputSchema.type, 'object', `${spec.name}.${tool.name} 的参数要是对象`)
})

test('codex 交给模型时丢掉的键只有范围（minimum、maximum），别的写了就到得了模型', () => {
  const dropped = new Set<string>()
  dynamicToolProblems(specs, dropped)
  // codex 的参数结构（codex-rs/tools/src/json_schema/types.rs 的 JsonSchema）不认范围：模型看不到上下限，
  // 写在说明里的才看得到。新用到别的会被丢掉的键时这里会知道
  assert.deepEqual([...dropped].sort(), ['maximum', 'minimum'])
})

test('litch_computer 的说明按桌面的平台出：Windows 那份也过得了校验，多一个 window 参数', () => {
  const [mac] = clientToolSpecs([CLIENT_TOOL_NAMESPACE.computer], { machine: null })
  const [win] = clientToolSpecs([CLIENT_TOOL_NAMESPACE.computer], {
    machine: null,
    desktopPlatform: 'win32',
  })
  assert.ok(mac && win)
  assert.deepEqual(dynamicToolProblems([win]), [])
  assert.match(mac.description, /^Control macOS apps/)
  assert.match(win.description, /^Control Windows apps/)
  assert.match(win.description, /Windows key/)
  assert.deepEqual(
    win.tools.map((tool) => tool.name),
    mac.tools.map((tool) => tool.name),
  )
  for (const tool of win.tools) {
    const properties = tool.inputSchema.properties as Record<string, unknown>
    if (tool.name === 'list_apps') continue
    assert.ok('window' in properties, `${tool.name} 在 Windows 上要有 window`)
  }
  for (const tool of mac.tools) {
    assert.ok(!('window' in (tool.inputSchema.properties as Record<string, unknown>)))
  }
  // 认不出的平台按 macOS
  const [other] = clientToolSpecs([CLIENT_TOOL_NAMESPACE.computer], {
    machine: null,
    desktopPlatform: 'linux',
  })
  assert.equal(other?.description, mac.description)
})

test('litch_browser 的命名空间说明不超过 1024 个字（codex 的上限；安全规则加句子时最容易超）', () => {
  const browser = specs.find((spec) => spec.name === CLIENT_TOOL_NAMESPACE.browser)
  assert.ok(browser)
  assert.ok(
    browser.description.length <= 1024,
    `litch_browser 的说明有 ${browser.description.length} 个字`,
  )
  // 要登录就调 request_sign_in（Litch 代填人批准的账号，或人自己登录）的那一条在里面
  assert.match(browser.description, /call `request_sign_in`: Litch fills a saved account/)
  assert.ok(browser.tools.some((tool) => tool.name === 'request_sign_in'))
})

test('request_sign_in 只增不改：原有的 tabId、site、reason 和必填照旧，新加的提示都是可选的平铺字符串', () => {
  const browser = specs.find((spec) => spec.name === CLIENT_TOOL_NAMESPACE.browser)
  const signIn = browser?.tools.find((tool) => tool.name === 'request_sign_in')
  assert.ok(signIn)
  const properties = signIn.inputSchema.properties as Record<string, Record<string, unknown>>
  assert.deepEqual(Object.keys(properties), [
    'tabId',
    'site',
    'reason',
    'origin',
    'usernameRef',
    'passwordRef',
    'submitRef',
  ])
  // 老的模型调用只带这三个、只有 reason 必填：新参数一个都不能变成必填
  assert.deepEqual(signIn.inputSchema.required, ['reason'])
  for (const name of ['origin', 'usernameRef', 'passwordRef', 'submitRef'])
    assert.deepEqual(Object.keys(properties[name] ?? {}), ['type', 'description'], name)
  for (const name of ['tabId', 'site', 'reason']) assert.equal(properties[name]?.type, 'string')
})

test('request_sign_in 代填的结果文字：原因只有固定几种、各带下一步，事先授权的换说法，都不带用户名', () => {
  assert.deepEqual(Object.keys(SIGN_IN_FILL_FAILURES), [
    'origin_changed',
    'page_changed',
    'locator_invalid',
    'not_user_visible',
    'insecure',
    'popup_needed',
    'no_answer',
    'unavailable',
  ])
  for (const why of Object.keys(SIGN_IN_FILL_FAILURES) as SignInFillFailure[]) {
    const text = signInResult.fillFailed(why)
    assert.match(text, new RegExp(`^Litch could not sign in automatically \\(${why}\\): `))
    assert.match(text, /\. [A-Z][^.]*/, `${why} 要给下一步`)
  }
  const origin = 'https://github.com'
  assert.equal(
    signInResult.filled(origin, 'user'),
    'Litch filled the account the user approved and submitted; the page loaded https://github.com. Take a fresh snapshot to check you are signed in.',
  )
  assert.match(signInResult.filled(origin, 'grant'), /authorized in advance for this task/)
  assert.match(signInResult.filledInPlace(origin, 'user'), /cleared the password fields/)
  assert.match(
    signInResult.reopened(`${origin}/login`, 't7', 'user'),
    /opened https:\/\/github\.com\/login in a new tab t7\. Use the new tab/,
  )
  assert.match(signInResult.declined('GitHub'), /^The user declined signing in to GitHub\./)
  assert.match(signInResult.needsVerification(), /Call `request_sign_in` again/)
  assert.match(signInResult.expired(), /expired before anyone answered/)
  // 结果里只说“人批准的那个账号”，没有放用户名的地方
  for (const by of ['user', 'grant'] as const)
    for (const text of [
      signInResult.filled(origin, by),
      signInResult.filledInPlace(origin, by),
      signInResult.reopened(origin, 't1', by),
    ])
      assert.doesNotMatch(text, /username|@/)
})
