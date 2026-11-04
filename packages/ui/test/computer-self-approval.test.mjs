import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { build } from '../../../node_modules/esbuild/lib/main.js'

const compiled = await build({
  stdin: {
    contents: `import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {ClientAskCard} from './src/composer/ClientAskCard.tsx';
export const render = (request) => renderToStaticMarkup(React.createElement(ClientAskCard, {deviceId:'remote', sessionId:'thread', request, waiting:0}));`,
    resolveDir: new URL('../', import.meta.url).pathname,
  },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  write: false,
  loader: { '.css': 'empty' },
  tsconfig: new URL('../tsconfig.json', import.meta.url).pathname,
  plugins: [
    {
      name: 'self-approval-fixture',
      setup(api) {
        api.onResolve({ filter: /app\/(appearance\.ts|services\.tsx|toasts\.tsx)$/ }, (args) => ({
          path: args.path,
          namespace: 'fixture',
        }))
        api.onLoad({ filter: /.*/, namespace: 'fixture' }, (args) => ({
          contents: args.path.endsWith('appearance.ts')
            ? `import {translate} from ${JSON.stringify(new URL('../src/i18n/index.ts', import.meta.url).pathname)};
export const useT=()=>{const t=(key,args)=>translate(globalThis.__selfLang,key,args);t.text=x=>x;return t;};`
            : args.path.endsWith('services.tsx')
              ? 'export const useServices=()=>({channel:{}}); export const useKey=()=>null;'
              : 'export const showToast=()=>{};',
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

test('自身授权卡中英文均突出风险、远程来源与三档，无始终允许或回车默认批准提示', () => {
  const request = {
    id: 'self',
    kind: 'clientAsk',
    itemId: null,
    device: { name: 'Remote fixture', kind: 'ssh', host: 'fixture-host' },
    tool: { namespace: 'litch_computer', name: 'get_app_state' },
    ask: { kind: 'computerSelf', id: 'self', nonce: 'nonce', desktopId: null },
    options: [
      { id: 'once', role: 'accept' },
      { id: 'session', role: 'acceptSession' },
      { id: 'always', role: 'acceptAlways' },
      { id: 'decline', role: 'decline' },
    ],
  }
  for (const lang of ['zh-CN', 'en']) {
    globalThis.__selfLang = lang
    const html = module.exports.render(request)
    assert.match(html, /role="alert"/)
    assert.match(html, /fixture-host/)
    for (const choice of ['once', 'session', 'always', 'decline'])
      assert.match(html, new RegExp(`data-option="${choice}"`))
    assert.match(
      html,
      lang === 'zh-CN' ? /24 小时内对所有对话允许/ : /Allow all conversations for 24 hours/,
    )
    assert.match(
      html,
      lang === 'zh-CN' ? /代替你批准请求或修改设置/ : /approval requests and settings/,
    )
    assert.doesNotMatch(html, /Always allow|始终允许|↵/)
  }
  delete globalThis.__selfLang
})
