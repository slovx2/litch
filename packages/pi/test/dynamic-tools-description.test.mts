import assert from 'node:assert/strict'
import test from 'node:test'
import { BROWSER_TOOLS } from '../../protocol/src/client-tools-browser.mjs'
import { clientTools, toolDescription } from '../src/dynamic-tools.mjs'

// Pi 没有命名空间这一层：命名空间的说明（litch_machine 开头写着“你在哪台机器、控制端是哪台”）要接在它第一个工具的说明前面，
// 不然模型看不到
test('命名空间的说明接在它第一个工具的说明前面，别的工具和单独的函数不带', () => {
  const tools = clientTools([
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
  const [tool] = clientTools([
    {
      type: 'namespace',
      name: 'litch_echo',
      tools: [{ type: 'function', name: 'echo', description: 'Echo.', inputSchema: {} }],
    },
  ])
  assert.equal(tool && toolDescription(tool), '[litch_echo.echo] Echo.')
})

test('request_sign_in 加的可选提示参数（origin、三个 ref）在新会话里原样交给 Pi，必填仍只有 reason', () => {
  const signIn = clientTools([BROWSER_TOOLS]).find((tool) => tool.name === 'request_sign_in')
  assert.ok(signIn)
  const properties = signIn.inputSchema.properties as Record<string, unknown>
  for (const name of ['origin', 'usernameRef', 'passwordRef', 'submitRef'])
    assert.ok(name in properties, name)
  assert.deepEqual(signIn.inputSchema.required, ['reason'])
})
