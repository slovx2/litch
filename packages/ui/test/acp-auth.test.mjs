import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { build } from '../../../node_modules/esbuild/lib/main.js'

// 执行两端正式账号卡；仅替换平台控件和状态来源，按钮事件仍走正式实现。
async function component(path) {
  const source = readFileSync(path, 'utf8')
  const imports = new Map(
    [...source.matchAll(/import\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/g)].map((m) => [
      m[2],
      m[1].split(',').map((p) => p.trim()),
    ]),
  )
  const values = {
    useT: '()=>((key,args)=>key+(args?.reason ?? ""))',
    useServices: '()=>({channel:{}})',
    useChannel: '()=>({})',
    whyNot: '(error)=>error.message',
    useAcpAuth: '()=>globalThis.__acpAuthState',
    ScrollView: '"ScrollView"',
    View: '"View"',
    Note: '"Note"',
    Button: '"Button"',
    StyleSheet: '{create:x=>x}',
  }
  const out = await build({
    entryPoints: [path],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'node',
    tsconfigRaw: { compilerOptions: { jsx: 'react', jsxFactory: 'h' } },
    jsx: 'transform',
    jsxFactory: 'h',
    banner: { js: 'const h=(type,props,...children)=>({type,props:{...props,children}});' },
    plugins: [
      {
        name: 'platform',
        setup(api) {
          api.onResolve({ filter: /.*/ }, (args) =>
            imports.has(args.path) ? { path: args.path, namespace: 'stub' } : undefined,
          )
          api.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => ({
            contents: imports
              .get(args.path)
              .map((key) => `export const ${key}=${values[key]};`)
              .join('\n'),
          }))
        },
      },
    ],
  })
  return (
    await import(
      `data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`
    )
  ).AcpAccounts
}
const nodes = (node) =>
  !node || typeof node !== 'object'
    ? []
    : Array.isArray(node)
      ? node.flatMap(nodes)
      : [node, ...nodes(node.props?.children)]

for (const [label, path] of [
  ['桌面', new URL('../src/devices/hconfig/AcpAccounts.tsx', import.meta.url)],
  [
    '手机',
    new URL('../../../apps/mobile/src/screens/devices/hconfig/AcpAccounts.tsx', import.meta.url),
  ],
])
  test(`${label}账号卡按状态呈现；按钮只传声明方式；忙时禁用；失败提供引导`, async () => {
    const Account = await component(path.pathname)
    const calls = []
    const state = {
      data: { status: 'signedOut', logout: true },
      busy: null,
      error: null,
      methods: [{ id: 'oauth-personal' }, { id: 'oauth-business' }],
      run: (...args) => calls.push(args),
    }
    globalThis.__acpAuthState = state
    try {
      const render = () => Account({ deviceId: 'dev', harness: 'agy' })
      const buttons = () =>
        nodes(render()).filter((n) => n.type === 'button' || n.type === 'Button')
      const login = buttons().find(
        (n) =>
          n.props['data-acp-login'] === 'oauth-personal' ||
          n.props.testID === 'hc:acp:login:oauth-personal',
      )
      assert.equal(calls.length, 0)
      ;(login.props.onClick ?? login.props.onPress)()
      assert.deepEqual(calls, [['login', 'oauth-personal']])
      const logout = () =>
        buttons().find((n) => 'data-acp-logout' in n.props || n.props.testID === 'hc:acp:logout')
      assert.equal(logout().props.disabled, true)
      state.data.status = 'signedIn'
      assert.equal(logout().props.disabled, false)
      ;(logout().props.onClick ?? logout().props.onPress)()
      assert.deepEqual(calls.at(-1), ['logout'])
      state.busy = 'login'
      assert.ok(buttons().every((n) => n.props.disabled))
      state.busy = null
      state.error = new Error('device offline')
      const failed = JSON.stringify(render())
      assert.match(failed, /hc.acp.faileddevice offline/)
      assert.match(failed, /hc.acp.instruction/)
      state.data = { status: 'unknown', logout: false }
      state.methods = []
      assert.equal(logout(), undefined)
      assert.match(JSON.stringify(render()), /hc.acp.unknown/)
      assert.match(JSON.stringify(render()), /hc.acp.terminal/)
    } finally {
      delete globalThis.__acpAuthState
    }
  })

test('共享登录状态机只读挂载、串行点击、操作后重读，离页后忽略迟到回包', async () => {
  const out = await build({
    entryPoints: [new URL('../src/devices/hconfig/useAcpAuth.ts', import.meta.url).pathname],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'node',
    plugins: [
      {
        name: 'hooks',
        setup(api) {
          api.onResolve({ filter: /^react$/ }, () => ({ path: 'react', namespace: 'hooks' }))
          api.onLoad({ filter: /.*/, namespace: 'hooks' }, () => ({
            contents: `
        export const useState=(v)=>globalThis.__authHooks.state(v);
        export const useRef=(v)=>globalThis.__authHooks.ref(v);
        export const useCallback=(f)=>f;
        export const useEffect=(f)=>globalThis.__authHooks.effect(f);`,
          }))
        },
      },
    ],
  })
  const { useAcpAuth } = await import(
    `data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`
  )
  const slots = []
  let cursor = 0,
    mount = true,
    effect,
    clean
  globalThis.__authHooks = {
    state(initial) {
      const i = cursor++
      if (!(i in slots)) slots[i] = initial
      return [
        slots[i],
        (v) => {
          slots[i] = v
        },
      ]
    },
    ref(initial) {
      const i = cursor++
      return (slots[i] ??= { current: initial })
    },
    effect(fn) {
      if (mount) effect = fn
    },
  }
  const calls = []
  const methods = ['oauth-personal', 'oauth-business', 'gemini-api-key'].map((id) => ({
    id,
    type: 'agent',
  }))
  let status = 'signedOut',
    unblock,
    reject = false
  const channel = {
    async command(name) {
      calls.push(name)
      if (name === 'acp.auth.authenticate') {
        await new Promise((resolve) => {
          unblock = resolve
        })
        if (reject) throw new Error('login failed')
        status = 'signedIn'
      }
      if (name === 'acp.auth.logout') status = 'signedOut'
      return { status, methods, logout: true, instruction: 'agy acp --login' }
    },
  }
  const render = () => {
    cursor = 0
    // biome-ignore lint/correctness/useHookAtTopLevel: 用固定顺序的测试调度器执行正式 hook
    return useAcpAuth(channel, 'dev', 'agy')
  }
  const flush = () => new Promise((resolve) => setImmediate(resolve))
  try {
    render()
    clean = effect()
    mount = false
    await flush()
    assert.deepEqual(calls, ['acp.auth.read'])
    assert.equal(render().data.status, 'signedOut')
    assert.deepEqual(
      render().methods.map((m) => m.id),
      ['oauth-personal', 'oauth-business'],
    )
    const first = render().run('login', 'oauth-personal')
    await render().run('login', 'oauth-personal')
    assert.equal(calls.filter((name) => name === 'acp.auth.authenticate').length, 1)
    assert.equal(render().busy, 'login')
    unblock()
    await first
    assert.equal(render().data.status, 'signedIn')
    assert.equal(calls.at(-1), 'acp.auth.read')
    await render().run('logout')
    assert.equal(render().data.status, 'signedOut')
    reject = true
    const failing = render().run('login', 'oauth-personal')
    unblock()
    await failing
    assert.equal(render().data, null)
    assert.match(render().error.message, /login failed/)
    reject = false
    const stale = render().run('login', 'oauth-personal')
    clean()
    unblock()
    await stale
    assert.equal(render().data, null)
  } finally {
    clean?.()
    delete globalThis.__authHooks
  }
})
