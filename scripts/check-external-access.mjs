// 无 access、有权限及已打开表单撤权：正式桌面和手机组件的浏览器回归。
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { globSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build } from '../apps/desktop/node_modules/esbuild/lib/main.js'
import { withChromiumTestArgs } from '../third_party/litch-automation/scripts/chromium-test-args.mjs'
import { Cdp, until } from './chrome-m0/cdp.mjs'

const native = `import React from 'react';
export const View = ({children}) => <div>{children}</div>;
export const Text = View;
export const Pressable = ({children,testID,onPress}) => <button data-testid={testID} onClick={onPress}>{children}</button>;
export const StyleSheet = {create:v=>v};
export const Linking = {openURL:async()=>{}};`
const controls = `import React from 'react';
export const Button = ({label,onPress,disabled,busy,testID}) => <button data-testid={testID} disabled={disabled||busy} onClick={onPress}>{label}</button>;
export const Field = ({label,value,onChangeText,editable,testID}) => <input aria-label={label} data-testid={testID} value={value} readOnly={editable===false} onChange={e=>onChangeText(e.target.value)}/>;
export const IconButton = Button;
export const Icon = () => null;`
const plugins = [
  {
    name: '手机原生控件替身',
    setup(b) {
      b.onResolve(
        {
          filter:
            /react-native$|^@react-navigation\/native$|\/shell\/services$|\/ui\/theme$|\/ui\/i18n$|\/ui\/kit\/(controls|Icon|overlays)$|\.\/DiscussionDrawer$/,
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
            : path === '@react-navigation/native'
              ? `export const useNavigation=()=>({navigate:(route,args)=>{ window.externalRecoveryNavigation = {route,args} }});`
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
  entryPoints: {
    bundle: 'scripts/external-access-fixture.tsx',
    style: 'packages/ui/src/styles/index.css',
  },
  outdir: 'fixture',
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
  const asset = result.outputFiles.find((file) => file.path.endsWith(`/fixture${req.url}`))
  res.setHeader(
    'Content-Type',
    asset ? (req.url.endsWith('.css') ? 'text/css' : 'text/javascript') : 'text/html',
  )
  res.end(
    asset?.text ??
      '<link rel="stylesheet" href="/style.css"><div id="root"></div><script type="module" src="/bundle.js"></script>',
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
  const shots = process.env.LITCH_EXTERNAL_ACCESS_SHOTS
  const shot = async (file, selector) => {
    if (!shots) return
    const clip = await read(
      `(()=>{const el=document.querySelector(${JSON.stringify(selector)});
        const clone=el.cloneNode(true);clone.id='screenshot-subject';
        Object.assign(clone.style,{position:'fixed',top:'12px',left:'12px',width:'850px',zIndex:'9999',background:'var(--panel)'});
        document.body.append(clone);const r=clone.getBoundingClientRect();
        return {x:r.x,y:r.y,width:r.width,height:r.height,scale:1}})()`,
    )
    try {
      const image = await cdp.call('Page.captureScreenshot', { format: 'png', clip })
      mkdirSync(shots, { recursive: true })
      writeFileSync(join(shots, file), Buffer.from(image.data, 'base64'))
    } finally {
      await read('document.querySelector("#screenshot-subject").remove()')
    }
  }
  await cdp.call('Emulation.setDeviceMetricsOverride', {
    width: 990,
    height: 1100,
    deviceScaleFactor: 1,
    mobile: false,
  })
  await cdp.call('Page.navigate', { url: `http://127.0.0.1:${server.address().port}` })
  const identityAdd = '[data-act=identity-add]'
  const repoAdd = '[data-act=repo-add]'
  const hidden = (selector) => `!document.querySelector(${JSON.stringify(selector)})`
  const enabled = (selector) =>
    `document.querySelector(${JSON.stringify(selector)})?.disabled === false`
  await wait('!!document.querySelector("[data-ext-page=remote] [data-ext-identities]")')
  assert.equal(await read(hidden(identityAdd)), true)
  assert.equal(await read(hidden(repoAdd)), true)
  assert.equal(await read('accessCalls.includes("external.identity.list")'), false)
  assert.equal(await read('accessCalls.includes("external.identity.repositories")'), false)
  assert.match(
    await read('document.querySelector("[data-ext-assignments]").textContent'),
    /Remote fixture manager/,
  )
  assert.equal(await read('document.querySelector("[data-act=autostart]").disabled'), true)
  assert.equal(await read('!!document.querySelector("#mobile [data-testid=github-accept]")'), false)
  await read(
    'setAccess({configure:true,configureAutostart:true,triageInbox:true,reassignInbox:true})',
  )
  await wait(enabled(identityAdd))
  const addPermissions = '[data-act=identity-add-permissions]'
  await wait(enabled(`[data-identity=fixture] ${addPermissions}`))
  assert.equal(await read(hidden(`[data-identity=granted] ${addPermissions}`)), true)
  assert.equal(await read(enabled(`[data-identity=revoked] ${addPermissions}`)), true)
  await read('window.__litchLook.set({lang:"zh-CN",skin:"standard",theme:"light"})')
  await shot('desktop-github-identities.png', '[data-ext-identities]')
  await click('#desktop-inbox [data-inbox-item=one] .ext-inbox-main')
  const ownDetail = '#desktop-inbox [data-inbox-detail=event]'
  await wait(`!!document.querySelector("${ownDetail}")`)
  assert.match(
    await read(`document.querySelector("${ownDetail}").textContent`),
    /GitHub 工具需要更新/,
  )
  assert.equal(
    await read(hidden(`${ownDetail} [data-act=manager-reset], ${ownDetail} button.ext-text-link`)),
    true,
  )
  await shot('desktop-manager-inbox.png', '#desktop-inbox')
  await click('#desktop-inbox [data-inbox-item=two] .ext-inbox-main')
  const otherRecovery = '#desktop-inbox [data-inbox-detail=other-event] button.ext-text-link'
  await wait(enabled(otherRecovery))
  const chrome = '#desktop-chrome-site [data-client-ask=site]'
  const context = await read(
    `[...document.querySelectorAll("${chrome} .req-meta")].map(e=>e.textContent)`,
  )
  assert.equal(context.length, 1)
  assert.match(context[0], /本机.*litch_browser.*navigate.*https:\/\/example\.com/)
  assert.equal(
    await read(`document.querySelector("${chrome} .well pre").textContent`),
    'https://example.com/docs/start',
    '合并说明行仍保留单独的完整页面网址',
  )
  for (const option of ['once', 'session', 'always', 'decline'])
    assert.equal(await read(enabled(`${chrome} [data-option=${option}]`)), true)
  await shot('desktop-chrome-site.png', chrome)
  await click(identityAdd)
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
  assert.equal(await read(hidden(identityAdd)), true)
  assert.equal(await read(hidden(repoAdd)), true)
  const detailReads = await read(
    'accessCalls.filter(name => /^external.identity.(list|repositories)$/.test(name)).length',
  )
  await read('setAccess({configure:false})')
  await wait('!!document.querySelector("[data-ext-admin-required]")')
  const permissionText = 'document.querySelector("[data-ext-admin-required]")?.textContent'
  await read('window.__litchLook.set({lang:"en"})')
  await wait(`/This connection is read-only/.test(${permissionText})`)
  await read('window.__litchLook.set({lang:"zh-CN"})')
  await wait(`/当前连接只能查看/.test(${permissionText})`)
  assert.equal(
    await read(
      'accessCalls.filter(name => /^external.identity.(list|repositories)$/.test(name)).length',
    ),
    detailReads,
  )
  await read('setAccess({configure:true})')
  await wait(enabled(identityAdd))
  await wait(enabled(repoAdd))
  await click(repoAdd)
  await wait('document.querySelector("dialog[open] [data-repo]")?.dataset.repo === "456"')
  await read('document.querySelector("dialog[open] .modal-head button").click()')
  await wait('!document.querySelector("dialog[open]")')
  assert.equal(await read('document.querySelector("[data-act=autostart]").disabled'), true)
  await read('window.__litchLook.set({lang:"zh-CN"})')
  await click('[data-act=source-expand]')
  const readinessText = 'document.querySelector("[data-ext-readiness]").innerText'
  assert.match(await read(readinessText), /可以从 GitHub 采集事件/)
  const recover = '[data-ext-readiness] [data-check=managerTools] [data-act=manager-reset]'
  await wait(enabled(recover))
  assert.match(await read(readinessText), /GitHub 工具需要更新/)
  await click(recover)
  await wait('!!document.querySelector("dialog[open]")')
  assert.match(await read('document.querySelector("dialog[open]").textContent'), /刷新|保留/)
  await click('dialog[open] .pick-ask-actions button')
  await wait('!document.querySelector("dialog[open]")')
  await read(
    `[...document.querySelectorAll('#mobile button')].find(b => b.textContent === 'mgh.openManagerRecovery').click()`,
  )
  assert.deepEqual(await read('window.externalRecoveryNavigation'), {
    route: 'ManagerConsole',
    args: { deviceId: 'remote', managerId: 'm1', tab: 'console' },
  })
  await click('[data-act=source-check]')
  await wait(
    'document.querySelector("[data-ext-readiness] [data-check=repository]")?.dataset.state === "blocked"',
  )
  assert.match(await read(readinessText), /工作目录的 origin 与此 GitHub 仓库不匹配/)
  assert.equal(await read('!!document.querySelector("[data-agent-owner]")'), true)
  await click('[data-act=identity-add]')
  await wait('!!document.querySelector("[data-act=identity-start]")')
  await click('[data-act=identity-start]')
  await wait(
    '/正在下载 GitHub CLI/.test(document.querySelector("[data-ext-login=download]")?.textContent)',
  )
  await read('failGithubCliDownload()')
  await wait('/粘贴令牌/.test(document.querySelector("[data-ext-login=error]")?.textContent)')
  await click('[data-act=identity-use-token]')
  await wait('!!document.querySelector("dialog[open] input[type=password]")')
  await read('setAccess(undefined)')
  await wait(hidden(identityAdd))
  assert.equal(await read(hidden(repoAdd)), true)
  assert.equal(await read('!!document.querySelector("[data-agent-owner]")'), false)
  assert.equal(await read('accessCalls.includes("external.inbox.triage")'), false)
  await read('setResultMissing(true)')
  await wait('document.querySelectorAll("[data-missing-result-reply]").length === 2')
  for (const root of ['#desktop', '#board']) {
    assert.equal(
      await read(`document.querySelector('${root} [data-missing-result-reply] a').href`),
      'https://github.com/example/demo/issues/8',
    )
  }
  await wait(`!!document.querySelector('#mobile [data-testid="missing-result-reply:X-1"]')`)
  await read('setResultMissing(false)')
  await wait(
    '!document.querySelector("[data-missing-result-reply], [data-testid^=missing-result-reply]")',
  )
  console.log(
    '通过：远程设备的身份和仓库入口、按设备列出经理、无配置权限不读身份明细、撤权即只读、下载提示、桌面工具恢复、手机跳转及回帖标记实时清除',
  )
} finally {
  cdp?.close()
  child.kill('SIGTERM')
  server.closeAllConnections()
  server.close()
}
