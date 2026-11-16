import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import { transformSync } from '../../../node_modules/esbuild/lib/main.js'
import { translator } from '../src/i18n/index.ts'

const t = translator('zh-CN')
const harness = {
  id: 'codex',
  state: 'unavailable',
  down: 'startFailed',
  repair: 'codexControlPermissions',
}
const nodes = (tree) =>
  Array.isArray(tree)
    ? tree.flatMap(nodes)
    : tree && typeof tree === 'object'
      ? [tree, ...nodes(tree.props?.children)]
      : []

function mount(mobile, command) {
  const module = { exports: {} }
  let cursor = 0
  const state = []
  const source = readFileSync(
    new URL(
      mobile
        ? '../../../apps/mobile/src/screens/devices/RepairCodexControl.tsx'
        : '../src/devices/manage/RepairCodexControl.tsx',
      import.meta.url,
    ),
    'utf8',
  )
  const element = (type, props) => ({ type, props })
  runInNewContext(transformSync(source, { loader: 'tsx', format: 'cjs', jsx: 'automatic' }).code, {
    module,
    exports: module.exports,
    require(name) {
      if (name === 'react/jsx-runtime') return { jsx: element, jsxs: element }
      if (name === 'react')
        return {
          useState(initial) {
            const key = cursor++
            if (!(key in state)) state[key] = initial
            return [
              state[key],
              (value) => {
                state[key] = value
              },
            ]
          },
        }
      if (name === 'react-native') return { Text: 'text', View: 'view' }
      if (name.endsWith('/appearance.ts') || name.endsWith('/i18n')) return { useT: () => t }
      if (name.endsWith('/theme')) return { useTheme: () => ({ c: {} }) }
      if (name.endsWith('/services.tsx')) return { useServices: () => ({ channel: { command } }) }
      if (name.endsWith('/services')) return { useChannel: () => ({ command }) }
      if (name.endsWith('/errors.ts')) return { whyNot: (error) => error.message }
      if (name.endsWith('/controls')) return { Button: 'button' }
      if (name.endsWith('/overlays') || name.endsWith('/Confirm.tsx')) return { Confirm: 'confirm' }
      throw Error(name)
    },
  })
  return (value = harness) => {
    cursor = 0
    return nodes(module.exports.RepairCodexControl({ deviceId: 'windows', harness: value }))
  }
}

for (const mobile of [false, true]) {
  test(`${mobile ? '手机' : '桌面'}：修复前确认、取消不发请求、修复中禁用、失败保留原因`, async () => {
    const sent = []
    let reject
    const render = mount(mobile, (...args) => {
      sent.push(args)
      return new Promise((_, fail) => {
        reject = fail
      })
    })
    const button = (tree) => tree.find((node) => node.type === 'button')
    const press = (node) => (node.props.onPress ?? node.props.onClick)()
    const confirmation = () => render().find((node) => node.type === 'confirm')
    assert.equal(render({ ...harness, repair: undefined }).length, 0, '旧设备不显示动作')
    assert.equal(render({ ...harness, id: 'pi' }).length, 0)
    press(button(render()))
    assert.equal(sent.length, 0)
    assert.match(confirmation().props.note ?? confirmation().props.detail, /备份 ACL/)
    confirmation().props.onClose()
    assert.equal(sent.length, 0)
    press(button(render()))
    const pending = (confirmation().props.onYes ?? confirmation().props.onConfirm)()
    assert.deepEqual(JSON.parse(JSON.stringify(sent)), [
      [
        'device.harness.restart',
        { deviceId: 'windows', harness: 'codex', repair: 'codexControlPermissions' },
      ],
    ])
    assert.equal(button(render()).props.disabled, true)
    reject(Error('occupied startup lock'))
    await pending
    await new Promise((resolve) => setImmediate(resolve))
    assert.match(JSON.stringify(render()), /occupied startup lock/)
    assert.equal(button(render()).props.disabled, false)
  })
}
