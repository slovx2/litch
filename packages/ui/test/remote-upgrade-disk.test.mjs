import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { build } from '../../../node_modules/esbuild/lib/main.js'
import { remoteButtonOf, remoteSteps } from '../src/devices/service.ts'

const compiled = await build({
  stdin: {
    contents: `import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {RemoteUpgradeNote} from './src/devices/RemoteUpgrade.tsx';
export const render = (view) => renderToStaticMarkup(React.createElement(RemoteUpgradeNote, {device: {id:'remote', name:'server', service:null}, view}));`,
    resolveDir: new URL('../', import.meta.url).pathname,
  },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  write: false,
  tsconfig: new URL('../tsconfig.json', import.meta.url).pathname,
  plugins: [
    {
      name: 'upgrade-view-fixture',
      setup(api) {
        api.onResolve({ filter: /app\/(appearance\.ts|services\.tsx|toasts\.tsx)$/ }, (args) => ({
          path: args.path,
          namespace: 'fixture',
        }))
        api.onLoad({ filter: /.*/, namespace: 'fixture' }, (args) => ({
          contents: args.path.endsWith('appearance.ts')
            ? `import {translate} from ${JSON.stringify(new URL('../src/i18n/index.ts', import.meta.url).pathname)};
export const useT = () => { const t=(key,args)=>translate(globalThis.__diskLang,key,args); t.text=x=>x; return t; };`
            : args.path.endsWith('services.tsx')
              ? 'export const useServices=()=>({channel:{}});'
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
const { render } = module.exports

test('磁盘不足的路径和数值直接出现在主区域，中英文均提示释放空间再重试', () => {
  const view = {
    target: '0.30.0',
    running: '0.26.0',
    installed: '0.26.0',
    method: 'script',
    capable: true,
    managed: false,
    action: 'upgrade',
    phase: {
      step: 'failed',
      at: 'diskSpace',
      text: null,
      detail: 'tar: original diagnostic',
      diskSpace: { path: '/home/dev path/.local/share', requiredKiB: 123456, availableKiB: 7 },
    },
  }
  assert.equal(remoteButtonOf(view), 'upgrade')
  assert.deepEqual(remoteSteps(view, null), [])
  for (const lang of ['zh-CN', 'en']) {
    globalThis.__diskLang = lang
    const html = render(view)
    assert.match(html, /data-failed="diskSpace"/)
    assert.match(html, /\/home\/dev path\/\.local\/share/)
    assert.match(html, /123456 KiB/)
    assert.match(html, /7 KiB/)
    assert.match(
      html,
      lang === 'zh-CN'
        ? /远程设备磁盘空间不足。释放空间后再点重试。/
        : /Free up space, then click Retry/,
    )
    assert.ok(!html.includes('tar: original diagnostic'), '详情默认未展开，空间说明仍然可见')
    const ordinary = render({
      ...view,
      phase: { step: 'failed', at: 'install', text: null, detail: 'other failure' },
    })
    assert.match(
      ordinary,
      lang === 'zh-CN' ? /安装脚本未能完成安装/ : /The install script didn’t finish/,
    )
    assert.ok(!ordinary.includes('123456 KiB'))
  }
  delete globalThis.__diskLang
})
