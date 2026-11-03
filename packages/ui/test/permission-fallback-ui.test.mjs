// 执行两端真实页面和设置条，替换平台组件与外围数据；验证提交回调而非源码字串。
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { build, transform } from 'esbuild'
import { tsImport } from 'tsx/esm/api'

const { translator } = await tsImport('../src/i18n/index.ts', import.meta.url)
const { newSessionSettings } = await tsImport(
  '../../core/src/projection/settings.mts',
  import.meta.url,
)
const { projectPermissionChoice } = await tsImport(
  '../../core/src/device/project-permissions.mts',
  import.meta.url,
)

async function load(relative) {
  const source = await readFile(new URL(relative, import.meta.url), 'utf8')
  const { code } = await transform(source, { loader: 'tsx', jsx: 'preserve' })
  const modules = new Map()
  for (const match of code.matchAll(/import\s*\{([^}]+)\}\s*from\s*["']([^"']+)["']/g)) {
    modules.set(
      match[2],
      match[1]
        .split(',')
        .map((part) => part.trim().split(/\s+as\s+/)[0])
        .filter(Boolean),
    )
  }
  const result = await build({
    stdin: { contents: code, loader: 'jsx' },
    bundle: true,
    write: false,
    format: 'esm',
    jsx: 'automatic',
    plugins: [
      {
        name: 'platform-fixture',
        setup(api) {
          api.onResolve({ filter: /.*/ }, ({ path }) => ({ path, namespace: 'fixture' }))
          api.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({
            contents:
              path === 'react/jsx-runtime'
                ? 'export const jsx=(type,props)=>({type,props});export const jsxs=jsx;export const Fragment="fragment";'
                : (modules.get(path) ?? [])
                    .map(
                      (name) =>
                        `export const ${name}=globalThis.__permissionUI.${name} ?? function ${name}(){};`,
                    )
                    .join('\n'),
          }))
        },
      },
    ],
  })
  return import(
    `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`
  )
}
function nodes(value) {
  if (Array.isArray(value)) return value.flatMap(nodes)
  if (!value || typeof value !== 'object') return []
  return [value, ...nodes(value.props?.children)]
}

for (const platform of ['desktop', 'mobile']) {
  test(`${platform}：超时、旧设备、断线不占用设置栏；默认或自选权限仍可提交`, async () => {
    const calls = []
    const notices = []
    const harness = { id: 'pi', state: 'ready', name: 'Pi', abilities: {} }
    const device = { connection: 'online', name: 'Test device', harnesses: [harness] }
    const options = {
      models: [],
      permissions: [
        { id: ':workspace', confirm: false, switchable: true },
        { id: ':read-only', confirm: false, switchable: true },
      ],
      plan: false,
    }
    let project
    let t = translator('zh-CN')
    const channel = {
      command: async (name, params) => {
        calls.push([name, params])
        return { sessionId: 'new' }
      },
    }
    const services = {
      channel,
      replica: { openSession: () => () => {}, store: { get: () => ({}) } },
    }
    const noop = () => {}
    globalThis.__permissionUI = {
      showToast: (toast) => notices.push(toast.text()),
      useState: (initial) => [typeof initial === 'function' ? initial() : initial, noop],
      useEffect: noop,
      useCallback: (fn) => fn,
      useT: () => t,
      useServices: () => services,
      useChannel: () => channel,
      keys: {
        devices: 'devices',
        device: () => 'device',
        workspaces: () => 'workspaces',
        session: () => 'session',
        summary: () => 'summary',
      },
      useKey: (key) => (key === 'devices' ? ['local'] : key === 'device' ? device : []),
      newSessionSettings,
      projectPermissionChoice,
      useProjectPermission: () => project,
      useNewHarness: () => harness,
      pickHarness: () => harness,
      useComposeOptions: () => options,
      useNewSessionDefaults: () => ({
        model: null,
        effort: null,
        speed: null,
        permission: ':workspace',
      }),
      useBranches: () => null,
      recallPicks: () => ({}),
      fitPicks: (x) => x,
      recallWhere: () => ({ worktree: false, from: '' }),
      fitFrom: (x) => x,
      useTheme: () => ({ c: { wire: {} }, font: {}, radius: {} }),
      StyleSheet: { create: (x) => x },
      useSafeAreaInsets: () => ({ bottom: 0 }),
      useKeyboardState: () => 0,
      useDraft: () => ({ text: '' }),
      fromOptions: () => [],
      lastPlace: () => null,
      goalIntent: () => ({ kind: 'message' }),
      acquireStore: () => ({ getMeta: () => ({}) }),
      localUserMessage: () => ({ text: 'hello', attachments: [] }),
      permissionText: () => ({ title: 'Workspace' }),
    }
    const previousWindow = globalThis.window
    globalThis.window = {
      setTimeout: (fn) => {
        fn()
        return 1
      },
      clearTimeout: noop,
    }
    try {
      const page = await load(
        platform === 'desktop'
          ? '../src/composer/NewSession.tsx'
          : '../../../apps/mobile/src/screens/new-session/NewSessionScreen.tsx',
      )
      const settings = await load(
        platform === 'desktop'
          ? '../src/composer/SettingsBar.tsx'
          : '../../../apps/mobile/src/detail/composer/SettingsBar.tsx',
      )
      for (const lang of ['zh-CN', 'en']) {
        const catalog = translator(lang)
        t = Object.assign(
          (key, args) => (key.startsWith('compose.') ? key : catalog(key, args)),
          catalog,
        )
        for (const [reason, selected] of [
          'timeout',
          'unavailable',
          'offline',
          'saveFailed',
        ].flatMap((reason) => [
          [reason, null],
          [reason, ':read-only'],
        ])) {
          const expected = selected ?? ':workspace'
          const noticesBefore = notices.filter(Boolean).length
          project = {
            permission: selected,
            readFailed: reason !== 'saveFailed',
            loading: false,
            saving: false,
            retrying: false,
            notice: t(`permission.project.${reason}`, {
              reason: t('permission.project.failedReason'),
            }),
            confirmed: () => false,
            persist: async (permission) => {
              assert.equal(permission, expected)
              return reason === 'unavailable' ? null : project.notice
            },
          }
          const root =
            platform === 'desktop'
              ? page.NewSession({
                  draft: { deviceId: 'local', workspaceId: null },
                  onPlace: noop,
                  onCreated: noop,
                  onDevices: noop,
                  assist: 0,
                })
              : page.NewSessionScreen({
                  route: { params: { deviceId: 'local', workspaceId: null } },
                  navigation: {
                    replace: (_route, params) => notices.push(params.permissionNotice),
                  },
                })
          const composer = nodes(root).find((node) => typeof node.props?.onSend === 'function')
          assert.ok(composer)
          assert.equal(composer.props.blocked, null)
          await composer.props.onSend('hello', [], [], 'hello')
          assert.equal(calls.at(-1)[0], 'session.create')
          assert.equal(calls.at(-1)[1].settings.permission, expected)
          if (reason !== 'unavailable')
            assert.equal(notices.at(-1), project.notice, '离开新建页后仍显示非阻断提示')
          else assert.equal(notices.filter(Boolean).length, noticesBefore, '旧设备新建不提示失败')
          const props = {
            options,
            settings: { permission: ':workspace', model: null, effort: null, speed: null },
            deviceId: 'local',
            harness: 'pi',
            fresh: true,
            onChange: noop,
          }
          const renderMobileSettings = settings.useComposeSettings
          const bar =
            platform === 'desktop'
              ? settings.SettingsBar(props)
              : renderMobileSettings(props).pickers
          assert.ok(!JSON.stringify(bar).includes(t('permission.project.readFailed')))
          assert.ok(!JSON.stringify(bar).includes(project.notice))
          assert.doesNotMatch(JSON.stringify([root, bar]), /RpcAbortError|litch\/|30000/)
          const retry = nodes(bar).find(
            (node) =>
              (node.props?.['aria-label'] ?? node.props?.accessibilityLabel) ===
              t('permission.project.retry'),
          )
          assert.equal(retry, undefined, '设置栏不显示重试入口')
        }
      }
    } finally {
      globalThis.window = previousWindow
      delete globalThis.__permissionUI
    }
  })
}
