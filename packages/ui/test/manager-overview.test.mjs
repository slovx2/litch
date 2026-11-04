import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { test } from 'node:test'
import { build } from '../../../node_modules/esbuild/lib/main.js'

// 服务端渲染概览，替掉文案与时钟；跳转、隐藏经理事项与时间线的整页行为由 client:check:manager 守着。
const compiled = await build({
  stdin: {
    contents: `import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {Overview} from './src/manager/Overview.tsx';
import {BoardReferencesContext} from './src/manager/BoardReferences.tsx';
export const render = (props) => renderToStaticMarkup(React.createElement(BoardReferencesContext.Provider, {value: {ids: new Set(['D-15']), open: () => {}}}, React.createElement(Overview, {onOpen: () => {}, ...props})));`,
    resolveDir: new URL('../', import.meta.url).pathname,
  },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  write: false,
  tsconfig: new URL('../tsconfig.json', import.meta.url).pathname,
  loader: { '.css': 'empty' },
  logLevel: 'error',
  plugins: [
    {
      name: 'overview-fixture',
      setup(api) {
        // 文案换成固定中文；时钟沿用真实模块，只把 useNow 换成不订阅的版本；
        // 外链换成普通 a（真实组件连着内置浏览器的状态）
        const clock = new URL('../src/app/clock.ts', import.meta.url).pathname
        const i18n = new URL('../src/i18n/index.ts', import.meta.url).pathname
        const src = new URL('../src/', import.meta.url).pathname
        const stubs = {
          [`${src}app/appearance.ts`]: 'appearance',
          [`${src}app/clock.ts`]: 'clock',
          [`${src}transcript/ExternalLink.tsx`]: 'ExternalLink',
        }
        api.onResolve({ filter: /(appearance|clock)\.ts$|ExternalLink\.tsx$/ }, (args) => {
          const stub =
            args.namespace === 'fixture' ? null : stubs[resolve(args.resolveDir, args.path)]
          return stub ? { path: stub, namespace: 'fixture' } : undefined
        })
        api.onLoad({ filter: /.*/, namespace: 'fixture' }, (args) => ({
          contents:
            args.path === 'ExternalLink'
              ? `import React from 'react';
export const ExternalLink = ({href, children}) => React.createElement('a', {href}, children);`
              : args.path === 'appearance'
                ? `import {translate} from ${JSON.stringify(i18n)};
export const useT = () => { const t=(key,args)=>translate('zh-CN',key,args); t.text=x=>x; t.lang='zh-CN'; return t; };
export const onAppearanceChange = () => () => {};`
                : `export * from ${JSON.stringify(clock)};
export const useNow = () => 0;`,
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

const counts = (pending = {}) =>
  Object.fromEntries(
    ['decisions', 'requests', 'reports', 'suggestions'].map((key) => [
      key,
      { pending: pending[key] ?? 0, total: 9 },
    ]),
  )
const situation = {
  text: '### 正在做\n- **回退编辑**：进行中\n\n### 等你\n- #D-15 插话怎么编辑',
  at: 0,
}

test('概览只有控制台四类计数和现状，按顺序排列，未完成的标出', () => {
  const html = render({ situation, counts: counts({ decisions: 3, requests: 1 }) })
  const order = [...html.matchAll(/data-overview-count="(\w+)"/g)].map((match) => match[1])
  assert.deepEqual(order, ['decisions', 'requests', 'reports', 'suggestions'])
  assert.match(html, /data-overview-count="decisions" data-pending="true"/)
  assert.match(html, /data-overview-count="requests" data-pending="true"/)
  assert.doesNotMatch(html, /data-overview-count="reports" data-pending/)
  assert.match(html, /title="未完成 3 · 共 9"/)
  // 经理事项和时间线不进概览
  assert.doesNotMatch(html, /mg-item|data-activity|经理事项/)
})

test('全部为 0 时整排标为安静', () => {
  assert.match(render({ situation, counts: counts() }), /data-quiet="true"/)
  assert.doesNotMatch(render({ situation, counts: counts({ reports: 1 }) }), /data-quiet/)
})

test('现状按 Markdown 渲染：小标题、列表、加粗与看板编号链接', () => {
  const html = render({ situation, counts: counts() })
  assert.match(html, /<h3[^>]*>正在做<\/h3>/)
  assert.match(html, /<ul[^>]*>\s*<li[^>]*>.*<strong>回退编辑<\/strong>/s)
  assert.match(html, /data-board-reference="D-15"/)
  assert.match(html, /更新于/)
})

test('没有现状时写明，没有刷新入口时不画图标', () => {
  const html = render({ situation: null, counts: counts() })
  assert.match(html, /经理尚未写现状/)
  assert.doesNotMatch(html, /data-act="manager-overview-refresh"/)
  assert.match(
    render({ situation, counts: counts(), refresh: { busy: false, run() {} } }),
    /data-act="manager-overview-refresh"[^>]*aria-label="刷新"/,
  )
})
