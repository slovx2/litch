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
import {ResetTargetSettings, ResetTargetPreview} from './src/manager/ResetTargetSettings.tsx';
export const previewHtml = (preview) => renderToStaticMarkup(React.createElement(ResetTargetPreview, {preview, deviceId:'local'}));
export const settingsHtml = (preview) => renderToStaticMarkup(React.createElement(ResetTargetSettings, {preview, dispatch: {harness:null,model:null,effort:null}, disabled:false,onChange:()=>{}}));
export const render = (manager, disabled = false) => renderToStaticMarkup(React.createElement(ResetManager, {manager, disabled}));`,
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
            : 'export const useKey=()=>globalThis.__resetFeatures ? {features:globalThis.__resetFeatures} : undefined; export const useServices=()=>({channel:{}});',
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
const { render, previewHtml, settingsHtml } = module.exports
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

const source = {
  harness: 'claude-code',
  model: 'claude-sonnet-4-6',
  effort: 'high',
  permission: ':workspace',
}
const target = { ...source, harness: 'codex', model: 'gpt-6.1', effort: 'medium' }
const preview = {
  source,
  target,
  managerId: 'm1',
  cwd: '/a/long/project',
  canSubmit: true,
  candidates: [
    {
      harness: 'claude-code',
      enabled: true,
      permissions: [':workspace'],
      reasons: [],
      models: [{ id: source.model, name: source.model, efforts: ['high'] }],
    },
    {
      harness: 'codex',
      enabled: true,
      permissions: [':workspace'],
      reasons: [],
      models: [{ id: target.model, name: target.model, efforts: ['medium'] }],
    },
    {
      harness: 'pi',
      enabled: false,
      permissions: [':danger-full-access'],
      models: [],
      reasons: [{ code: 'notValidated', message: 'raw reason' }],
    },
  ],
  capabilityChanges: [{ capability: 'nativeBackground', before: true, after: false }],
  dispatchChanges: [{ field: 'harness', before: 'claude-code', after: 'codex' }],
  reasons: [],
}

test('接班预览用中英展示源目标、权限与具体降级；不可选项保留原因且默认收起', () => {
  for (const lang of ['zh-CN', 'en']) {
    globalThis.__resetLang = lang
    const html = previewHtml(preview)
    assert.match(html, /Claude Code/)
    assert.match(html, /Codex/)
    assert.match(html, /gpt-6\.1/)
    assert.match(html, /claude-sonnet-4-6/)
    assert.match(
      html,
      lang === 'zh-CN'
        ? /原生后台任务.*支持.*→.*不支持/
        : /Native background tasks.*Supported.*→.*Unsupported/,
    )
    assert.match(html, lang === 'zh-CN' ? /工作线默认设置变化/ : /Workline default changes/)
    const settings = settingsHtml(preview)
    assert.match(settings, /<details class="reset-target-settings">/)
    assert.doesNotMatch(settings, /<details[^>]+open/)
    assert.match(settings, /<option value="pi" disabled="">/)
    assert.match(
      settings,
      lang === 'zh-CN' ? /未完成此运行方式的经理验收/ : /has not been validated/,
    )
    assert.match(
      settings,
      lang === 'zh-CN' ? /不支持当前权限/ : /Does not support the current permissions/,
    )
    assert.match(
      previewHtml({ ...preview, source: { ...source, permission: null } }),
      lang === 'zh-CN' ? /无法确认当前权限/ : /permissions could not be verified/,
    )
  }
})

test('支持接班的设备等待时显示已确认源目标和取消；提交后接班失败有独立状态', () => {
  globalThis.__resetFeatures = { resetTarget: true }
  try {
    for (const lang of ['zh-CN', 'en']) {
      globalThis.__resetLang = lang
      const operation = {
        source: { ...source, threadId: 'old' },
        target,
        committed: false,
        handover: 'pending',
      }
      const waiting = render({
        ...manager('waiting', 'replace'),
        reset: { ...manager('waiting', 'replace').reset, operation },
      })
      assert.match(waiting, /Claude Code → Codex/)
      assert.match(waiting, /manager-reset-cancel/)
      assert.doesNotMatch(waiting, /disabled=""/)
      const failed = render({
        ...manager('ready', 'replace'),
        reset: {
          ...manager('ready', 'replace').reset,
          operation: { ...operation, committed: true, handover: 'failed' },
        },
      })
      assert.match(
        failed,
        lang === 'zh-CN' ? /新会话已创建，接班失败/ : /New session created; handover failed/,
      )
    }
  } finally {
    delete globalThis.__resetFeatures
  }
})
