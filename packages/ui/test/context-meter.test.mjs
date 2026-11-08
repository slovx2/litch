import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'
import { build } from '../../../node_modules/esbuild/lib/main.js'

const compiled = await build({
  stdin: {
    contents: `import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {ContextMeter} from './src/composer/ContextMeter.tsx';
export const render = (usage) => renderToStaticMarkup(React.createElement(ContextMeter, {usage}));`,
    resolveDir: new URL('../', import.meta.url).pathname,
  },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  write: false,
  tsconfig: new URL('../tsconfig.json', import.meta.url).pathname,
  plugins: [
    {
      name: 'context-meter-fixture',
      setup(api) {
        api.onResolve(
          { filter: /(?:app\/(?:appearance\.ts|popover\.ts|toasts\.tsx)|AccountLimits\.tsx)$/ },
          (args) => ({ path: args.path, namespace: 'fixture' }),
        )
        api.onLoad({ filter: /.*/, namespace: 'fixture' }, (args) => ({
          contents: args.path.endsWith('appearance.ts')
            ? `import {translator} from ${JSON.stringify(new URL('../src/i18n/index.ts', import.meta.url).pathname)}; export const useT=()=>translator('zh-CN');`
            : args.path.endsWith('popover.ts')
              ? 'export const usePopover=()=>({open:false});'
              : args.path.endsWith('AccountLimits.tsx')
                ? 'export const AccountLimits=()=>null; export const MeterRow=()=>null; export const useAccountLimits=()=>[];'
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

test('窗口未知也渲染已报告的 token 数，提示原因且不画虚构百分比', () => {
  const html = module.exports.render({ usedTokens: 42_000, windowTokens: null })
  assert.match(html, />42k<\/span>/)
  assert.match(html, /已用 42k token，上下文窗口未知/)
  assert.ok(!html.includes('ctx-fill'))
  assert.ok(!html.includes('尚未报告上下文用量'))
  assert.equal(module.exports.render(null), '')
  assert.match(module.exports.render({ usedTokens: 42_000, windowTokens: 200_000 }), />21%<\/span>/)
})
