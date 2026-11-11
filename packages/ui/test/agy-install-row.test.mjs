import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from '../../../node_modules/esbuild/lib/main.js'
import { translator } from '../src/i18n/index.ts'

// 执行正式安装行与按钮事件，仅替换 React 状态和设备通道；不执行真实下载。
test('agy 安装行：最新版按钮投递到所选远程设备，已装重检，失败可见', async () => {
  const stubs = new Map([
    ['react', 'export const useState=v=>[v,()=>{}]; export const useId=()=>"log";'],
    ['../app/appearance.ts', 'export const useT=()=>globalThis.__agyT;'],
    ['../app/services.tsx', 'export const useServices=()=>({channel:globalThis.__agyChannel});'],
    ['../app/errors.ts', 'export const whyNot=e=>String(e);'],
    ['../app/toasts.tsx', 'export const showToast=()=>{};'],
    [
      '../transcript/ExternalLink.tsx',
      'export const ExternalLink=({href,children,...props})=>({type:"a",props:{...props,href,children}});',
    ],
  ])
  const output = await build({
    entryPoints: [new URL('../src/install/InstallRow.tsx', import.meta.url).pathname],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'esm',
    tsconfigRaw: { compilerOptions: { jsx: 'react', jsxFactory: 'h' } },
    jsx: 'transform',
    jsxFactory: 'h',
    banner: {
      js: 'const h=(type,props,...children)=>typeof type==="function"?type({...props,children}):({type,props:{...props,children}});',
    },
    plugins: [
      {
        name: 'platform',
        setup(api) {
          api.onResolve({ filter: /.*/ }, (args) =>
            stubs.has(args.path) ? { path: args.path, namespace: 'stub' } : undefined,
          )
          api.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => ({
            contents: stubs.get(args.path),
          }))
        },
      },
    ],
  })
  const { InstallRow } = await import(
    `data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`
  )
  const calls = []
  globalThis.__agyChannel = {
    command: async (...args) => {
      calls.push(args)
    },
  }
  const nodes = (node) =>
    !node || typeof node !== 'object'
      ? []
      : Array.isArray(node)
        ? node.flatMap(nodes)
        : [node, ...nodes(node.props?.children)]
  const text = (node) =>
    typeof node === 'string'
      ? node
      : !node || typeof node !== 'object'
        ? ''
        : Array.isArray(node)
          ? node.map(text).join(' ')
          : text(node.props?.children)
  const info = {
    harness: 'agy',
    installable: true,
    method: 'script',
    installed: null,
    minimum: null,
    verified: null,
    latest: null,
    latestError: null,
    manual: 'curl -fsSL https://antigravity.google/cli/install.sh | bash',
    docsUrl: 'https://antigravity.google/docs/getting-started',
  }
  const device = { id: 'remote-device', harnesses: [{ id: 'agy', state: 'disabled' }] }
  const view = { available: true, loading: null, versions: [info], jobs: [] }
  const render = () => InstallRow({ device, harnessId: 'agy', view, name: 'Antigravity' })
  try {
    for (const lang of ['zh-CN', 'en']) {
      globalThis.__agyT = translator(lang)
      const tree = render()
      const buttons = nodes(tree).filter((n) => n.type === 'button')
      assert.equal(buttons.length, 1)
      assert.equal(text(buttons[0]), globalThis.__agyT('install.latestOnlyBtn'))
      assert.match(text(tree), /agy CLI/)
      assert.ok(nodes(tree).some((n) => n.props['data-agy-disabled']))
      await buttons[0].props.onClick()
      assert.deepEqual(calls.at(-1), [
        'install.start',
        {
          deviceId: 'remote-device',
          harness: 'agy',
          version: 'latest',
        },
      ])
    }
    info.installed = '1.5.2'
    const installed = render()
    assert.match(text(installed), /1\.5\.2/)
    assert.ok(!nodes(installed).some((n) => n.props['data-act'] === 'install'))
    await nodes(installed)
      .find((n) => n.props['data-act'] === 'install-recheck')
      .props.onClick()
    // 重检本身是异步操作，等它完成第二次通道调用。
    await Promise.resolve()
    assert.deepEqual(calls.at(-1), ['install.versions', { deviceId: 'remote-device' }])
    info.installed = null
    view.jobs = [
      {
        harness: 'agy',
        job: 'failed',
        state: 'failed',
        log: ['checksum mismatch'],
        failure: 'Download failed',
      },
    ]
    const failed = render()
    assert.match(text(failed), /Download failed/)
    assert.ok(nodes(failed).some((n) => n.props['data-act'] === 'install-log'))
    assert.match(text(failed), /https:\/\/antigravity.google\/cli\/install.sh/)
  } finally {
    delete globalThis.__agyT
    delete globalThis.__agyChannel
  }
})
