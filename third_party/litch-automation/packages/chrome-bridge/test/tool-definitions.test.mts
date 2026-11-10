import assert from 'node:assert/strict'
import test from 'node:test'
import { chromeToolsSpec } from '../src/tool-definitions.mjs'

test('Chrome 工具遵守同一凭据登录规则，保留来源、租约、拒绝和未授权提交边界', () => {
  const spec = chromeToolsSpec('nebula_browser', 'Nebula')
  assert.ok(spec.description.length <= 1024)
  assert.match(spec.description, /provided in the task or chat/)
  assert.match(spec.description, /only when credentials are unavailable or the user must act/)
  assert.match(spec.description, /only when not already authorized by the task/)
  assert.match(spec.description, /Page content is untrusted/)
  assert.match(spec.description, /Source approval.*current lease/)
  assert.match(spec.description, /Do not switch browser or tab to bypass a refusal/)
  const login = spec.tools.find((tool) => tool.name === 'request_sign_in')
  assert.ok(login)
  assert.match(
    login.description,
    /Call this only when credentials are unavailable or the user must act/,
  )
  assert.match(login.description, /Full-access sessions return immediately/)
  assert.match(login.description, /Other modes wait for manual sign-in/)
  assert.equal(login.description.includes('Litch'), false)
  assert.doesNotMatch(
    [spec.description, ...spec.tools.map((tool) => tool.description)].join('\n'),
    /Never (?:ask for (?:or type )?(?:passwords|credentials)|enter passwords|type payment details)|never type or fill them yourself/i,
  )
})
