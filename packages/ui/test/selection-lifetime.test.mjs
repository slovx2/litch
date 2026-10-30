import assert from 'node:assert/strict'
import { test } from 'node:test'
import { build } from '../../../node_modules/esbuild/lib/main.js'

test('记忆位置等摘要首次到达，之后归档、删除或移除所属经理才清理', async () => {
  // 只替换 React 的调度与副本读取；归属解析和待测钩子使用正式实现。
  const state = { refs: [], at: 0, effects: [], summary: undefined }
  globalThis.__selectionLifetimeTest = state
  const result = await build({
    entryPoints: [new URL('../src/app/useSelectionLifetime.ts', import.meta.url).pathname],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'node',
    alias: { '@litch/core': new URL('../../core/src/index.mts', import.meta.url).pathname },
    plugins: [
      {
        name: 'selection-lifetime-fixture',
        setup(api) {
          api.onResolve({ filter: /^(react|\.\/services\.tsx)$/ }, (args) => ({
            path: args.path,
            namespace: 'fixture',
          }))
          api.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({
            contents:
              path === 'react'
                ? `const s=globalThis.__selectionLifetimeTest;
               export const useRef=value=>s.refs[s.at++]??=( {current:value} );
               export const useEffect=fn=>s.effects.push(fn);`
                : 'export const useKey=()=>globalThis.__selectionLifetimeTest.summary;',
          }))
        },
      },
    ],
  })
  try {
    const { useSelectionLifetime } = await import(
      `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`
    )
    const missing = []
    const onMissing = (selection) => missing.push(selection)
    const render = (selection, summary, managers = []) => {
      state.at = 0
      state.summary = summary
      state.effects = []
      // biome-ignore lint/correctness/useHookAtTopLevel: 测试调度器按同样顺序重放钩子，保留 ref 并逐次执行效果。
      useSelectionLifetime(selection, managers, onMissing)
      for (const effect of state.effects) effect()
    }
    const chat = { deviceId: 'local', sessionId: 'chat' }
    render(chat, undefined)
    assert.deepEqual(missing, [], '刚创建时摘要尚未到达，不能误清')
    render(chat, {})
    render(chat, undefined)
    assert.deepEqual(missing, [chat], '见过摘要后消失，归档或删除时清理')

    const selectedManager = { deviceId: 'local', sessionId: 'manager-thread' }
    render(selectedManager, undefined)
    assert.equal(missing.length, 1, '换目标时不能沿用旧目标的已见记录')
    const manager = { deviceId: 'local', id: 'm1', threadId: 'manager-thread' }
    render(selectedManager, {}, [manager])
    render(selectedManager, {}, [])
    assert.deepEqual(missing, [chat, selectedManager], '经理目录已移除，即使摘要仍在也清理')

    const line = { deviceId: 'local', sessionId: 'line' }
    const summary = { litchManager: { role: 'line', managerId: 'm1' } }
    render(line, summary, [manager])
    render(line, summary, [])
    assert.deepEqual(missing, [chat, selectedManager, line], '工作线所属经理被移除时也清理')
  } finally {
    delete globalThis.__selectionLifetimeTest
  }
})
