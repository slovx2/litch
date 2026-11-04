import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'
import { build } from '../../../node_modules/esbuild/lib/main.js'

// 渲染正式组件；只替换浏览器外观与通道上下文，确认等待时原按钮可取消且不新增一行。
const compiled = await build({
  stdin: {
    contents: `import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {ResetManager} from './src/manager/ResetManager.tsx';
export const render = (manager, disabled = false) => renderToStaticMarkup(React.createElement(ResetManager, {manager, disabled}));`,
    resolveDir: new URL('../', import.meta.url).pathname,
  },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  write: false,
  tsconfig: new URL('../tsconfig.json', import.meta.url).pathname,
  plugins: [
    {
      name: 'manager-reset-context',
      setup(api) {
        api.onResolve({ filter: /app\/(appearance\.ts|services\.tsx)$/ }, (args) => ({
          path: args.path,
          namespace: 'fixture',
        }))
        api.onLoad({ filter: /.*/, namespace: 'fixture' }, (args) => ({
          contents: args.path.endsWith('appearance.ts')
            ? `import {translator} from ${JSON.stringify(new URL('../src/i18n/index.ts', import.meta.url).pathname)};
export const useT=()=>translator(globalThis.__resetLang);`
            : 'export const useServices=()=>({channel:{}});',
          resolveDir: new URL('../', import.meta.url).pathname,
        }))
      },
    },
  ],
})
const module = { exports: {} }
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(
  createRequire(import.meta.url),
  module,
  module.exports,
)
const { render } = module.exports
const manager = (phase, mode = 'refresh') => ({
  id: 'm1',
  deviceId: 'local',
  harness: 'claude-code',
  status: 'active',
  reset: { mode, phase, current: 'new', applied: 'old', outdated: true },
})

test('桌面 waiting 将原重置图标变为可用的取消图标，中英说明区分两种等待', () => {
  for (const lang of ['zh-CN', 'en']) {
    globalThis.__resetLang = lang
    const html = render(manager('waiting'))
    assert.match(html, /data-act="manager-reset-cancel"/)
    assert.doesNotMatch(html, /disabled=""/)
    assert.equal((html.match(/<button/g) ?? []).length, 1)
    assert.match(html, lang === 'zh-CN' ? /aria-label="取消重置"/ : /aria-label="Cancel reset"/)
    assert.match(html, lang === 'zh-CN' ? /当前回合结束后生效/ : /current turn finishes/)
    assert.match(
      render(manager('waiting', 'replace')),
      lang === 'zh-CN' ? /后台任务和临时追问/ : /background tasks and questions/,
    )
    assert.match(render(manager('waiting'), true), /disabled=""/)
    for (const phase of ['summarizing', 'applying']) {
      const busy = render(manager(phase))
      assert.match(busy, /disabled=""/)
      assert.doesNotMatch(busy, /manager-reset-cancel/)
    }
    assert.doesNotMatch(render(manager('idle')), /disabled=""/)
  }
})
