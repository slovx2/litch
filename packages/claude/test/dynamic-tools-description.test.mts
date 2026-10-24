import assert from 'node:assert/strict'
import test from 'node:test'
import { BROWSER_TOOLS } from '../../protocol/src/client-tools-browser.mjs'
import { dynamicToolSpecs, toolDescription } from '../src/dynamic-tools.mjs'
import { jsonSchemaValidator } from '../src/json-schema.mjs'

// CLI 没有命名空间这一层：命名空间的说明（litch_machine 开头写着“你在哪台机器、控制端是哪台”）要接在它第一个工具的说明前面，
// 不然模型看不到
test('命名空间的说明接在它第一个工具的说明前面，别的工具和单独的函数不带', () => {
  const tools = dynamicToolSpecs([
    {
      type: 'namespace',
      name: 'litch_machine',
      description: 'You are running on "dev-box".',
      tools: [
        { type: 'function', name: 'machines', description: 'List machines.', inputSchema: {} },
        { type: 'function', name: 'exec', description: 'Run a command.', inputSchema: {} },
      ],
    },
    { type: 'function', name: 'plain', description: 'A function.', inputSchema: {} },
  ])
  assert.deepEqual(tools.map(toolDescription), [
    '[litch_machine.machines] You are running on "dev-box".\n\nList machines.',
    '[litch_machine.exec] Run a command.',
    '[functions.plain] A function.',
  ])
})

test('命名空间没有说明时照旧', () => {
  const [tool] = dynamicToolSpecs([
    {
      type: 'namespace',
      name: 'litch_echo',
      tools: [{ type: 'function', name: 'echo', description: 'Echo.', inputSchema: {} }],
    },
  ])
  assert.equal(tool && toolDescription(tool), '[litch_echo.echo] Echo.')
})

// request_sign_in 加了可选的提示参数（origin、三个 ref）：新会话里原样交给 CLI；入口按定义校验调用参数，
// 老的调用（只有 tabId、site、reason）照样过，带新参数的也过，定义里没有的键照旧拒绝
test('request_sign_in 的新参数原样交给 CLI，新老两种调用都过参数校验', () => {
  const signIn = dynamicToolSpecs([BROWSER_TOOLS]).find((tool) => tool.name === 'request_sign_in')
  assert.ok(signIn)
  const properties = signIn.inputSchema.properties as Record<string, unknown>
  for (const name of ['origin', 'usernameRef', 'passwordRef', 'submitRef'])
    assert.ok(name in properties, name)
  const validate = jsonSchemaValidator(signIn.inputSchema).compile(signIn.inputSchema)
  assert.ok(validate({ tabId: 't1', site: 'GitHub', reason: '要看私有仓库' }))
  assert.ok(
    validate({
      reason: '要看私有仓库',
      origin: 'https://github.com',
      usernameRef: 'e3',
      passwordRef: 'e4',
      submitRef: 'e5',
    }),
  )
  assert.ok(!validate({ reason: '要看私有仓库', password: 'x' }))
})
