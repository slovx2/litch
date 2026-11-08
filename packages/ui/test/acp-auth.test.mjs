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
    useState: '(value)=>[value,()=>{}]',
    openOutside: '(url)=>{globalThis.__authOpened=url}',
    Linking: '{openURL:async(url)=>globalThis.__authOpened=url}',
    setStringAsync: 'async(url)=>{globalThis.__authCopied=url}',
    TextInput: '"TextInput"',
    ScrollView: '"ScrollView"',
    View: '"View"',
    Note: '"Note"',
    Button: '"Button"',
    StyleSheet: '{create:x=>x}',
  }
  if (String(path).endsWith('AcpAccounts.tsx') && String(path).includes('apps/mobile')) {
    imports.set('expo-clipboard', ['setStringAsync'])
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
      methods: [{ id: 'oauth-personal' }],
      login: null,
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
      state.login = {
        attemptId: 'one',
        url: 'https://accounts.google.com/o/oauth2/auth?state=fake',
      }
      assert.match(JSON.stringify(render()), /hc.acp.copy/)
      assert.match(JSON.stringify(render()), /hc.acp.open/)
      assert.match(JSON.stringify(render()), /hc.acp.code/)
      const named = (name) => buttons().find((n) => JSON.stringify(n.props).includes(name))
      const open = named('hc.acp.open')
      ;(open.props.onClick ?? open.props.onPress)()
      assert.equal(globalThis.__authOpened, state.login.url)
      state.busy = 'continue'
      const cancel = named('hc.acp.cancel')
      assert.equal(cancel.props.disabled, false)
      ;(cancel.props.onClick ?? cancel.props.onPress)()
      assert.deepEqual(calls.at(-1), ['cancel', 'one'])
    } finally {
      delete globalThis.__acpAuthState
      delete globalThis.__authOpened
    }
  })

test('共享状态机：链接跨重渲染保留、回填成功刷新、错误可重试、取消和离页清理', async () => {
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
        export const useCallback=(f,deps)=>globalThis.__authHooks.callback(f,deps);
        export const useEffect=(f,deps)=>globalThis.__authHooks.effect(f,deps);`,
          }))
        },
      },
    ],
  })
  const { useAcpAuth } = await import(
    `data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`
  )
  const slots = []
  let cursor = 0
  const effects = []
  const same = (a, b) => a?.length === b.length && a.every((v, i) => v === b[i])
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
      return (slots[cursor++] ??= { current: initial })
    },
    callback(fn, deps) {
      const i = cursor++
      if (!same(slots[i]?.deps, deps)) slots[i] = { fn, deps }
      return slots[i].fn
    },
    effect(fn, deps) {
      const i = cursor++
      if (!same(slots[i]?.deps, deps)) {
        const before = slots[i]
        const next = { deps, clean: null }
        slots[i] = next
        effects.push(() => {
          before?.clean?.()
          next.clean = fn()
        })
      }
    },
  }
  const login = {
    attemptId: 'attempt',
    url: 'https://accounts.google.com/o/oauth2/auth?state=fake',
  }
  const methods = ['oauth-personal', 'oauth-business', 'gemini-api-key'].map((id) => ({
    id,
    type: 'agent',
  }))
  const calls = []
  let status = 'signedOut',
    resolveStart,
    rejectSubmit,
    hold = false,
    wrong = false
  const channel = {
    async command(name, params) {
      calls.push({ name, params })
      if (name === 'acp.auth.authenticate')
        return new Promise((resolve) => {
          resolveStart = resolve
        })
      if (name === 'acp.auth.continue') {
        if (wrong) throw new Error('invalid code')
        if (hold)
          await new Promise((_resolve, reject) => {
            rejectSubmit = reject
          })
        status = 'signedIn'
      }
      if (name === 'acp.auth.cancel') {
        rejectSubmit?.(new Error('cancelled'))
        return {}
      }
      if (name === 'acp.auth.logout') status = 'signedOut'
      return { status, methods, logout: true }
    },
  }
  const render = () => {
    cursor = 0
    // biome-ignore lint/correctness/useHookAtTopLevel: 固定顺序运行正式 hook，模拟依赖变化和 effect 清理。
    const value = useAcpAuth(channel, 'remote-device', 'agy')
    for (const effect of effects.splice(0)) effect()
    return value
  }
  const clean = () => {
    for (const slot of slots) slot?.clean?.()
  }
  const flush = () => new Promise((resolve) => setImmediate(resolve))
  const start = async () => {
    const pending = render().run('login', 'oauth-personal')
    resolveStart({ login })
    await pending
    return render()
  }
  try {
    render()
    await flush()
    assert.equal(render().data.status, 'signedOut')
    assert.deepEqual(
      render().methods.map((m) => m.id),
      ['oauth-personal'],
    )
    const pending = render().run('login', 'oauth-personal')
    await render().run('login', 'oauth-personal')
    assert.equal(calls.filter((c) => c.name === 'acp.auth.authenticate').length, 1)
    resolveStart({ login })
    await pending
    assert.deepEqual(render().login, login)
    await flush()
    assert.deepEqual(render().login, login, '收到 URL 后重渲染不能触发挂载清理')
    await render().run('continue', 'good')
    assert.equal(render().data.status, 'signedIn')
    assert.equal(render().login, null)
    assert.equal(calls.at(-1).name, 'acp.auth.read')
    await render().run('logout')
    await start()
    wrong = true
    await render().run('continue', 'bad')
    assert.match(render().error.message, /invalid code/)
    assert.equal(render().login, null)
    wrong = false
    await start()
    await render().run('cancel')
    assert.equal(render().login, null)
    await start()
    hold = true
    const submitted = render().run('continue', 'good')
    await render().run('cancel')
    await submitted
    assert.equal(render().error, null, '取消成功不能被被取消的提交回包覆盖')
    assert.equal(render().login, null)
    hold = false
    await start()
    clean()
    await flush()
    assert.equal(calls.at(-1).name, 'acp.auth.cancel')
    const stale = render().run('login', 'oauth-personal')
    clean()
    resolveStart({ login })
    await stale
    assert.equal(calls.at(-1).name, 'acp.auth.cancel', '离页后迟到的登录进程也必须撤销')
    assert.ok(calls.every((c) => c.params.deviceId === 'remote-device'))
  } finally {
    clean()
    delete globalThis.__authHooks
  }
})
