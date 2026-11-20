// 无 access、有权限及已打开表单撤权：正式桌面和手机组件的浏览器回归。
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { globSync, mkdtempSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build } from '../apps/desktop/node_modules/esbuild/lib/main.js'
import { withChromiumTestArgs } from '../third_party/litch-automation/scripts/chromium-test-args.mjs'
import { Cdp, until } from './chrome-m0/cdp.mjs'

const native = `import React from 'react';
export const View = ({children}) => <div>{children}</div>;
export const Text = View;
export const StyleSheet = {create:v=>v};
export const Linking = {openURL:async()=>{}};`
const controls = `import React from 'react';
export const Button = ({label,onPress,disabled,busy,testID}) => <button data-testid={testID} disabled={disabled||busy} onClick={onPress}>{label}</button>;
export const Field = ({label,value,onChangeText,editable,testID}) => <input aria-label={label} data-testid={testID} value={value} readOnly={editable===false} onChange={e=>onChangeText(e.target.value)}/>;
export const IconButton = Button;`
const plugins = [
  {
    name: '手机原生控件替身',
    setup(b) {
      b.onResolve(
        {
          filter:
            /react-native$|\/shell\/services$|\/ui\/theme$|\/ui\/i18n$|\/ui\/kit\/(controls|Icon|overlays)$|\.\/DiscussionDrawer$/,
        },
        (args) => {
          if (!args.importer.includes('/apps/mobile/')) return
          return { path: args.path, namespace: 'native' }
        },
      )
      b.onLoad({ filter: /.*/, namespace: 'native' }, ({ path }) => ({
        loader: 'jsx',
        resolveDir: resolve('packages/ui'),
        contents:
          path === 'react-native'
            ? native
            : /shell\/services/.test(path)
              ? `export const useChannel=()=>window.mobileServices.channel; export const useReplica=()=>window.mobileServices.replica; export const useKey=()=>[];`
              : /ui\/theme/.test(path)
                ? `export const useTheme=()=>({c:{},font:{size:{meta:12}}});`
                : /ui\/i18n/.test(path)
                  ? `export const useT=()=>Object.assign(x=>x,{lang:'en',text:x=>x});`
                  : /overlays/.test(path)
                    ? `import React from 'react'; export const Sheet=({visible,actions})=>visible?<div>{actions.map((a,i)=><button key={i} onClick={a.onPress}>{a.label}</button>)}</div>:null;`
                    : /DiscussionDrawer/.test(path)
                      ? `import React from 'react'; export const DiscussionDrawer=({children,footer})=><div>{children}{footer}</div>;`
                      : controls,
      }))
    },
  },
]
const result = await build({
  entryPoints: ['scripts/external-access-fixture.tsx'],
  bundle: true,
  write: false,
  format: 'esm',
  jsx: 'automatic',
  plugins,
  nodePaths: [resolve('packages/ui/node_modules')],
  alias: {
    '@litch/core': resolve('packages/core/src/index.mts'),
    react: resolve('packages/ui/node_modules/react'),
  },
  logLevel: 'silent',
})
const server = createServer((req, res) => {
  res.setHeader('Content-Type', req.url === '/bundle.js' ? 'text/javascript' : 'text/html')
  res.end(
    req.url === '/bundle.js'
      ? result.outputFiles[0].text
      : '<div id="root"></div><script type="module" src="/bundle.js"></script>',
  )
})
await new Promise((done) => server.listen(0, '127.0.0.1', done))
const work = mkdtempSync(join(tmpdir(), 'litch-access-'))
const binary =
  process.env.LITCH_CHROME_BINARY ??
  globSync(
    join(
      homedir(),
      'Library/Caches/ms-playwright/chromium-*/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    ),
  )
    .sort()
    .at(-1)
assert.ok(binary?.includes('for Testing'))
const child = spawn(
  binary,
  withChromiumTestArgs([
    '--headless=new',
    `--user-data-dir=${work}/profile`,
    '--remote-debugging-port=0',
    '--no-first-run',
    '--disable-background-networking',
    'about:blank',
  ]),
  { env: { PATH: process.env.PATH, HOME: work }, stdio: 'ignore' },
)
let cdp
try {
  const port = await until(
    () => Number(readFileSync(join(work, 'profile/DevToolsActivePort'), 'utf8').split('\n')[0]),
    '调试端口',
  )
  const tabs = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
  cdp = await Cdp.connect(tabs.find((t) => t.type === 'page').webSocketDebuggerUrl)
  cdp.listeners.add((e) => {
    if (e.method === 'Runtime.exceptionThrown')
      console.error(
        e.params.exceptionDetails.exception?.description ?? e.params.exceptionDetails.text,
      )
  })
  await cdp.call('Runtime.enable')
  const read = async (expression) => {
    const r = await cdp.call('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })
    if (r.exceptionDetails)
      throw Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
    return r.result.value
  }
  const wait = (expression) => until(() => read(expression), expression)
  const click = (s) => read(`document.querySelector(${JSON.stringify(s)}).click()`)
  await cdp.call('Page.navigate', { url: `http://127.0.0.1:${server.address().port}` })
  await wait('!!document.querySelector("[data-act=identity-add]")')
  await wait('document.querySelector("[data-act=identity-add]").disabled')
  assert.equal(await read('document.querySelector("[data-act=autostart]").disabled'), true)
  assert.equal(await read('!!document.querySelector("#mobile [data-testid=github-accept]")'), false)
  await read(
    'setAccess({configure:true,configureAutostart:true,triageInbox:true,reassignInbox:true})',
  )
  await wait('!document.querySelector("[data-act=identity-add]").disabled')
  await click('[data-act=identity-add]')
  await wait('!!document.querySelector("dialog[open]")')
  await click('#triage [data-act=triage-accept]')
  await click('#mobile [data-testid=github-accept]')
  await wait('!!document.querySelector("#mobile [data-testid=github-accept-title]")')
  assert.equal(
    await read('document.querySelector("#mobile [data-testid=github-accept-title]").readOnly'),
    false,
  )
  await read('setAccess({reassignInbox:true})')
  await wait('!document.querySelector("dialog[open]")')
  await wait('document.querySelector("#triage input").disabled')
  await wait('document.querySelector("#mobile [data-testid=github-accept-title]").readOnly')
  assert.equal(
    await read('document.querySelector("#mobile [data-testid=github-triage-submit]").disabled'),
    true,
  )
  assert.equal(await read('document.querySelector("[data-act=identity-add]").disabled'), true)
  await read('setAccess({configure:true})')
  await wait('!document.querySelector("[data-act=identity-add]").disabled')
  assert.equal(await read('document.querySelector("[data-act=autostart]").disabled'), true)
  await read('window.__litchLook.set({lang:"zh-CN"})')
  await click('[data-act=source-expand]')
  const readinessText = 'document.querySelector("[data-ext-readiness]").innerText'
  assert.match(await read(readinessText), /可以从 GitHub 采集事件/)
  await click('[data-act=source-check]')
  await wait(
    'document.querySelector("[data-ext-readiness] [data-check=repository]")?.dataset.state === "blocked"',
  )
  assert.match(await read(readinessText), /工作目录的 origin 与此 GitHub 仓库不匹配/)
  assert.equal(await read('!!document.querySelector("[data-agent-owner]")'), true)
  await read('setAccess(undefined)')
  await wait('document.querySelector("[data-act=identity-add]").disabled')
  assert.equal(await read('!!document.querySelector("[data-agent-owner]")'), false)
  assert.equal(await read('accessCalls.includes("external.inbox.triage")'), false)
  console.log(
    '通过：缺 access 只读、有权限可编辑、撤权关闭配置向导且桌面/手机已开表单立即只读、配置与自启独立',
  )
} finally {
  cdp?.close()
  child.kill('SIGTERM')
  server.closeAllConnections()
  server.close()
}
