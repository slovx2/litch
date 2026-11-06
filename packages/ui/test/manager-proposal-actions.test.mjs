import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'
import { build } from '../../../node_modules/esbuild/lib/main.js'

const compiled = await build({
  stdin: {
    contents: `import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {ProposalActs} from './src/tree/ProposalCard.tsx';
export const render=(sourceIsManager,inbox)=>renderToStaticMarkup(React.createElement(ProposalActs,{deviceId:'local',sessionId:'source',proposal:{id:'p',sourceIsManager},inbox}));`,
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
        // 只验真实按钮组件；编辑弹窗和对话正文不在本用例的渲染范围。
        api.onResolve(
          { filter: /\/(SpawnDialog|TreeCards|CardMarkdown|actions)\.tsx$/ },
          (args) => ({ path: args.path, namespace: 'children' }),
        )
        api.onLoad({ filter: /.*/, namespace: 'children' }, () => ({
          contents:
            'export const SpawnDialog=()=>null; export const CardMarkdown=()=>null; export const markOf=()=>null; export const useActions=()=>({});',
        }))
        api.onResolve({ filter: /(?:^|\/)(appearance|services)(?:\.tsx?)?$/ }, (args) => ({
          path: args.path,
          namespace: 'fixture',
        }))
        api.onLoad({ filter: /.*/, namespace: 'fixture' }, (args) => ({
          contents: args.path.includes('appearance')
            ? 'export const useT=()=>Object.assign((key)=>key,{text:x=>x}); export const onAppearanceChange=()=>()=>{};'
            : 'export const useKey=()=>({connection:"online"}); export const useKeys=()=>[]; export const useServices=()=>({channel:{}});',
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

for (const inbox of [false, true]) {
  test(`对话/侧栏与看板共用按钮 inbox=${inbox}：经理只有开始和忽略，普通卡保留原地执行和编辑`, () => {
    const actions = (sourceIsManager) =>
      [
        ...module.exports
          .render(sourceIsManager, inbox)
          .matchAll(/data-act="(start|here|edit|dismiss)"/g),
      ].map((match) => match[1])
    assert.deepEqual(actions(true), ['start', 'dismiss'])
    assert.deepEqual(actions(false), ['start', 'here', 'edit', 'dismiss'])
  })
}
