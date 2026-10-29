// 挂载常驻 SideSlot 的冷启动分支；不加载重型侧面板，执行真实 cue 的订阅效果。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { build } from '../../../node_modules/esbuild/lib/main.js'

test('侧面板从未加载时也订阅活动，首个 surface 自动打开预览', async () => {
  const effects = [],
    subscriptions = [],
    shown = []
  globalThis.__cueTest = { effects, subscriptions, shown }
  const mocks = {
    react: `export const useEffect=f=>globalThis.__cueTest.effects.push(f);
      export const useLayoutEffect=useEffect, useMemo=f=>f(), useRef=x=>({current:x}), useState=x=>[x,()=>{}];
      export const lazy=()=>()=>{throw Error('冷启动不应渲染懒加载面板')}; export const Suspense=()=>null;`,
    '@litch/core': `export const keys={summary:()=> 'summary',workspaces:()=> 'workspaces'};`,
    'services.tsx': `export const useKey=k=>k==='summary'?{workspaceId:null,cwd:'/fixture'}:[];
      export const useServices=()=>({replica:{store:{get:()=>undefined}},channel:{subscribe:(key,sink)=>{globalThis.__cueTest.subscriptions.push({key,sink});return ()=>{};}}});`,
    'side.ts': `export const useSide=()=>({open:false,raised:0}),setSideView=()=>{},viewKey=()=> 'd/s',toggleSide=()=>{},showSideTab=()=>{};
      export const showSideTabPassive=x=>globalThis.__cueTest.shown.push(x);`,
    'store.ts': `export const BROWSER_TAB='browser',onPendingShow=()=>()=>{},setViewing=()=>false;`,
    'bridge.ts': `export const ownerKey=()=>'';`,
    'roots.ts': `export const sessionRoots=()=>[];`,
    'appearance.ts': `export const useT=()=>()=>'';`,
    'actions.ts': `export const requestOpenSession=()=>{};`,
    'toasts.tsx': `export const dismissToast=()=>{},showToast=()=>{};`,
    'toasts.ts': `export const dismissToast=()=>{},showToast=()=>{};`,
    'icons.tsx': `export const Icon=()=>null;`,
  }
  const result = await build({
    entryPoints: [new URL('../src/side/SideSlot.tsx', import.meta.url).pathname],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'node',
    jsx: 'transform',
    plugins: [
      {
        name: 'fixture',
        setup(api) {
          api.onResolve({ filter: /.*/ }, (args) => {
            const key = args.path in mocks ? args.path : args.path.split('/').at(-1)
            if (key in mocks) return { path: key, namespace: 'fixture' }
            if (args.path === './SidePanel.tsx') return { path: 'panel', namespace: 'fixture' }
          })
          api.onLoad({ filter: /.*/, namespace: 'fixture' }, (args) => ({
            contents:
              args.path === 'panel'
                ? 'export const SidePanel=()=>{throw Error("懒加载边界被突破")};'
                : mocks[args.path],
          }))
        },
      },
    ],
  })
  const oldDocument = globalThis.document
  const oldWindow = globalThis.window
  globalThis.document = { addEventListener() {}, removeEventListener() {} }
  globalThis.window = {}
  const cleanups = []
  try {
    const { SideSlot } = await import(
      `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`
    )
    assert.equal(
      SideSlot({ selection: { deviceId: 'd', sessionId: 's' }, draft: null, page: null }),
      null,
    )
    for (const effect of effects) cleanups.push(effect())
    const cue = subscriptions.find((s) => s.key.kind === 'automationPreview')
    assert.ok(cue, '冷启动常驻组件必须订阅预览')
    assert.equal(cue.key.observeOnly, true)
    cue.sink.snapshot({ surface: { surfaceId: 'window' } })
    cue.sink.snapshot({ surface: { surfaceId: 'window' } })
    assert.deepEqual(shown, ['automationPreview'])
  } finally {
    for (const cleanup of cleanups) cleanup?.()
    globalThis.document = oldDocument
    globalThis.window = oldWindow
    delete globalThis.__cueTest
  }
})
