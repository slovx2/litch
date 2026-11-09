import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'
import { build } from '../../../node_modules/esbuild/lib/main.js'

const compiled = await build({
  stdin: {
    contents: `import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {ProposalActs, Brief} from './src/tree/ProposalCard.tsx';
export const renderBrief=(background,prompt,expanded=false)=>renderToStaticMarkup(React.createElement(Brief,{background,prompt,expanded,renderText:({text})=>React.createElement("div",{"data-md-test":true},text)}));
export const render=(sourceIsManager,inbox,worktree=false)=>renderToStaticMarkup(React.createElement(ProposalActs,{deviceId:'local',sessionId:'source',proposal:{id:'p',sourceIsManager,worktree},inbox}));`,
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
      name: 'proposal-actions-fixture',
      setup(api) {
        // 静态按钮夹具只取客户端外部状态的当前快照；订阅更新另由 operation 与窗口验收覆盖。
        api.onResolve({ filter: /^react$/ }, (args) =>
          args.importer.endsWith('/tree/proposals.ts')
            ? { path: 'proposal-store-react', namespace: 'proposal-store' }
            : undefined,
        )
        api.onLoad({ filter: /.*/, namespace: 'proposal-store' }, () => ({
          resolveDir: new URL('../', import.meta.url).pathname,
          contents: `export * from ${JSON.stringify(createRequire(import.meta.url).resolve('react'))};
export const useSyncExternalStore=(_subscribe,getSnapshot)=>getSnapshot();`,
        }))
        // 只验真实按钮组件；编辑弹窗和对话正文不在本用例的渲染范围。
        api.onResolve(
          { filter: /\/(SpawnDialog|TreeCards|CardMarkdown|actions)\.tsx$/ },
          (args) => ({ path: args.path, namespace: 'children' }),
        )
        api.onLoad({ filter: /.*/, namespace: 'children' }, () => ({
          contents:
            'export const SpawnDialog=()=>null; export const CardMarkdown=()=>null; export const markOf=()=>null; export const useOpenSession=()=>undefined;',
        }))
        api.onResolve({ filter: /(?:^|\/)(appearance|services)(?:\.tsx?)?$/ }, (args) => ({
          path: args.path,
          namespace: 'fixture',
        }))
        api.onLoad({ filter: /.*/, namespace: 'fixture' }, (args) => ({
          contents: args.path.includes('appearance')
            ? 'export const useT=()=>Object.assign((key)=>key,{text:x=>x}); export const onAppearanceChange=()=>()=>{};'
            : 'export const useKey=()=>({connection:"online",worktrees:true}); export const useKeys=()=>[]; export const useServices=()=>({channel:{}});',
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

test('卡片仍可修改工作树：预检期间只禁用开始，不禁用开关', () => {
  const pending = module.exports.render(true, true, true)
  assert.match(pending, /data-act="start" disabled=""/)
  assert.match(pending, /worktree.check.pending/)
  const checkbox = pending.match(/<input[^>]*data-act="worktree"[^>]*>/)?.[0]
  assert.ok(checkbox)
  assert.doesNotMatch(checkbox, /disabled/)
  const shared = module.exports.render(true, true, false)
  assert.doesNotMatch(shared, /data-act="start" disabled=""|worktree.check.pending/)
})

for (const inbox of [false, true]) {
  test(`对话/侧栏与看板共用按钮 inbox=${inbox}：经理保留开始、编辑和忽略，普通卡还可原地执行`, () => {
    const actions = (sourceIsManager) =>
      [
        ...module.exports
          .render(sourceIsManager, inbox)
          .matchAll(/data-act="(start|here|edit|dismiss)"/g),
      ].map((match) => match[1])
    assert.deepEqual(actions(true), ['start', 'edit', 'dismiss'])
    assert.deepEqual(actions(false), ['start', 'here', 'edit', 'dismiss'])
  })
}

for (const [background, prompt] of [
  ['背景第一句。背景细节。', '执行任务全文'],
  ['', '任务理由。任务细节。'],
  ['', '短任务'],
]) {
  test(`建议简报默认不挂载全文，短卡与无背景也可展开：${background || prompt}`, () => {
    const folded = module.exports.renderBrief(background, prompt)
    assert.match(folded, /aria-expanded="false"/)
    assert.doesNotMatch(folded, /data-md-test|data-part="task"|data-part="background"/)
    const open = module.exports.renderBrief(background, prompt, true)
    assert.match(open, /aria-expanded="true"/)
    assert.ok(open.includes(prompt))
    if (background) assert.ok(open.includes(background))
  })
}
