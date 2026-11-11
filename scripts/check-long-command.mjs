// 隐藏 Electron + 正式 React 对话组件 + 独立核心工具进程。所有内容合成。
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build } from '../node_modules/esbuild/lib/main.js'
import { createServer } from '../packages/ui/node_modules/vite/dist/node/index.js'
import { withChromiumTestArgs } from '../third_party/litch-automation/scripts/chromium-test-args.mjs'

const repo = resolve(import.meta.dirname, '..')
const require = createRequire(new URL('../apps/desktop/package.json', import.meta.url))
const label = process.argv.includes('--baseline') ? 'baseline' : 'fixed'
const replyDelay = process.argv.includes('--immediate') ? 0 : 500
const artifact = join(
  repo,
  '.artifacts/long-command',
  `${label}${replyDelay === 0 ? '-immediate' : ''}`,
)
mkdirSync(artifact, { recursive: true })
const scratch = mkdtempSync(join(tmpdir(), 'long-command-'))
const core = join(artifact, 'core.cjs')
await build({
  entryPoints: [join(repo, 'scripts/long-command-core.mts')],
  outfile: core,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  sourcemap: true,
})
const baselinePaths = [
  'packages/core/src/replica/replica.mts',
  ...[
    'transcript/actions.tsx',
    'transcript/SessionMentions.tsx',
    'transcript/SystemCard.tsx',
    'tree/ProposalCard.tsx',
    'tree/TreeCards.tsx',
    'tree/EventBar.tsx',
  ].map((p) => `packages/ui/src/${p}`),
]
const original =
  label === 'baseline'
    ? new Map(
        baselinePaths.map((p) => [
          join(repo, p),
          execFileSync('git', ['show', `2dc1ce21:${p}`], { cwd: repo, encoding: 'utf8' }),
        ]),
      )
    : null
const vite = await createServer({
  root: join(repo, 'packages/ui'),
  plugins: original
    ? [
        {
          name: 'baseline-frontend',
          enforce: 'pre',
          load(id) {
            return original.get(id)
          },
        },
      ]
    : [],
  server: { host: '127.0.0.1', port: 0, hmr: false },
  logLevel: 'error',
})
await vite.listen()
const url = `${vite.resolvedUrls.local[0]}test/long-command-fixture.html?lang=zh-CN`

async function probe() {
  const wait = async (read, name, timeout = 180000) => {
    const until = performance.now() + timeout
    while (performance.now() < until) {
      const value = read()
      if (value) return value
      await new Promise((r) => setTimeout(r, 20))
    }
    throw new Error(`超时 ${name}`)
  }
  const measures = []
  const measure = async (selector, ready, name) => {
    const button = await wait(() => document.querySelector(selector), selector)
    const start = performance.now(),
      at = Date.now()
    const result = new Promise((resolve) => {
      const observer = new MutationObserver(() => {
        if (!ready()) return
        observer.disconnect()
        requestAnimationFrame(() => resolve(performance.now() - start))
      })
      observer.observe(document.body, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
      })
    })
    button.click()
    const ms = await result
    measures.push({
      name,
      at,
      start,
      feedbackMs: ms,
      nodes: document.querySelectorAll('*').length,
      turns: document.querySelectorAll('[data-search-turn]').length,
    })
  }
  const editAllowed = () =>
    document.querySelector('.act-edit')?.getAttribute('aria-disabled') === 'false'
  let enabledDuringMount = false
  // 轮询可能错过首次提交后很短的可编辑窗口；记录首屏挂载期间的每次 DOM 提交。
  const mounting = new MutationObserver(() => {
    if (document.querySelector('.send.stop') && editAllowed()) enabledDuringMount = true
  })
  mounting.observe(document.body, { subtree: true, childList: true, attributes: true })
  await wait(
    () =>
      document.querySelector('.send.stop') &&
      document.querySelector('.act-edit') &&
      document.querySelectorAll('[data-search-turn]').length >= 4,
    '初始内容',
  )
  mounting.disconnect()
  if (enabledDuringMount || editAllowed()) throw new Error('运行中不能编辑历史')
  await measure(
    '.send.stop',
    () => !!document.querySelector('.composer-stopping'),
    'stop-during-mount',
  )
  await wait(() => !document.querySelector('.send.stop'), '停止终态')
  await wait(editAllowed, '停止后解除历史编辑限制')
  measures.at(-1).terminalMs = performance.now() - measures.at(-1).start
  await wait(() => document.querySelectorAll('[data-search-turn]').length >= 1265, '全历史分批挂载')
  await new Promise((r) => setTimeout(r, 500))
  // 正常发送：用正式 textarea 和发送按钮；不走测试专属命令。
  const area = document.querySelector('.composer textarea') ?? document.querySelector('textarea')
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(
    area,
    '合成大会话里的普通发送',
  )
  area.dispatchEvent(new Event('input', { bubbles: true }))
  await new Promise((r) => setTimeout(r, 50))
  await measure('.send', () => area.value === '', 'send')
  const sent = measures.at(-1)
  await wait(() => document.querySelector('[data-search-turn^="sent"] .umsg-text'), '新气泡')
  sent.bubbleMs = performance.now() - sent.start
  if (editAllowed()) throw new Error('新回合开始后必须恢复编辑限制')
  // 全历史已经挂载时再停一次，防止只在首屏还没画出来时才有快速反馈。
  await measure('.send.stop', () => !!document.querySelector('.composer-stopping'), 'stop-loaded')
  await wait(() => !document.querySelector('.send.stop'), '发送终态')
  await wait(editAllowed, '再次停止后解除历史编辑限制')
  measures.at(-1).terminalMs = performance.now() - measures.at(-1).start
  // 编辑靠前的历史，制造批量删除；保留 20 回合用于核对结果。
  const target = await wait(
    () => document.querySelector('[data-search-turn="t20"] .act-edit'),
    '编辑目标',
  )
  target.click()
  await wait(() => document.querySelector('.umsg-edit'), '编辑框')
  await measure(
    '.umsg-edit-bar .primary',
    () => document.querySelector('.umsg-edit-bar .primary')?.textContent.includes('正在应用编辑…'),
    'edit',
  )
  const editStart = measures.at(-1).start
  await wait(() => !document.querySelector('.umsg-edit'), '批量回退')
  await wait(() => document.querySelectorAll('[data-search-turn]').length <= 20, '视图删除完成')
  measures.push({ name: 'edit-completed', ms: performance.now() - editStart })
  await new Promise((r) => setTimeout(r, 100))
  return {
    measures,
    metrics: window.longFixture.metrics,
    tasks: window.longFixture.tasks,
    finalTurns: document.querySelectorAll('[data-search-turn]').length,
  }
}

const preload = join(artifact, 'preload.cjs')
writeFileSync(
  preload,
  `const {ipcRenderer,contextBridge}=require('electron');contextBridge.exposeInMainWorld('longRequest',()=>ipcRenderer.send('long-request'));ipcRenderer.on('long-port',e=>window.postMessage('long-port','*',e.ports));`,
)
const main = join(artifact, 'main.cjs')
writeFileSync(
  main,
  `
const {app,BrowserWindow,MessageChannelMain,utilityProcess,ipcMain}=require('electron');
const {writeFileSync}=require('node:fs');
const {Session}=require('node:inspector');
const profiler=new Session();profiler.connect();profiler.post('Profiler.enable');profiler.post('Profiler.start');
app.setPath('userData',${JSON.stringify(scratch)});
app.whenReady().then(async()=>{
 app.dock?.hide();
 const child=utilityProcess.fork(${JSON.stringify(core)},[],{env:{PATH:process.env.PATH,HOME:${JSON.stringify(scratch)},CODEX_HOME:${JSON.stringify(join(scratch, 'codex'))},LITCH_LONG_REPLY_MS:${JSON.stringify(String(replyDelay))}},stdio:'pipe'});
 let profileDone;const coreProfile=new Promise(resolve=>profileDone=resolve);
 const timing=[];child.on('message',msg=>{timing.push(...(msg.timing??[]));if(msg.profile){writeFileSync(${JSON.stringify(join(artifact, 'core.cpuprofile'))},JSON.stringify(msg.profile));profileDone();}});
 child.stderr.on('data',data=>console.error(String(data)));
 const win=new BrowserWindow({show:false,width:1200,height:900,webPreferences:{preload:${JSON.stringify(preload)},backgroundThrottling:false}});
 ipcMain.on('long-request',()=>{const {port1,port2}=new MessageChannelMain();child.postMessage({},[port1]);win.webContents.postMessage('long-port',null,[port2]);});
 const dbg=win.webContents.debugger;
 let failure;win.webContents.on('console-message',(_e,_level,msg)=>console.error(msg));
 const watch=setInterval(()=>win.webContents.executeJavaScript('JSON.stringify({turns:document.querySelectorAll("[data-search-turn]").length,metrics:window.longFixture?.metrics.slice(-5)})').then(v=>writeFileSync(${JSON.stringify(join(artifact, 'progress.json'))},v)).catch(()=>{}),5000);
 try{await win.loadURL(${JSON.stringify(url)});dbg.attach('1.3');await dbg.sendCommand('Profiler.enable');await dbg.sendCommand('Profiler.start');const result=await win.webContents.executeJavaScript(${JSON.stringify(`(${probe.toString()})()`)},true);
 writeFileSync(${JSON.stringify(join(artifact, 'result.json'))},JSON.stringify({...result,core:timing},null,2));console.log('LONG_RESULT '+JSON.stringify(result.measures));}
 catch(error){failure=error;console.error(error.stack)}
 finally{clearInterval(watch);const {profile}=await dbg.sendCommand('Profiler.stop');writeFileSync(${JSON.stringify(join(artifact, 'renderer.cpuprofile'))},JSON.stringify(profile));child.postMessage({profile:true});await Promise.race([coreProfile,new Promise(r=>setTimeout(r,2000))]);await new Promise(resolve=>profiler.post('Profiler.stop',(_error,data)=>{writeFileSync(${JSON.stringify(join(artifact, 'main.cpuprofile'))},JSON.stringify(data.profile));resolve()}));child.kill();app.exit(failure?1:0)}
});
`,
)
const desktop = spawn(require('electron'), withChromiumTestArgs([main]), {
  cwd: repo,
  env: {
    PATH: process.env.PATH,
    HOME: scratch,
    CODEX_HOME: join(scratch, 'codex'),
    TMPDIR: scratch,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let output = ''
desktop.stdout.on('data', (data) => {
  output += data
})
desktop.stderr.on('data', (data) => {
  output += data
  writeFileSync(join(artifact, 'desktop.log'), output)
})
const timer = setTimeout(() => desktop.kill('SIGKILL'), 300000)
try {
  const code = await new Promise((resolve) => desktop.on('exit', resolve))
  writeFileSync(join(artifact, 'desktop.log'), output)
  assert.equal(code, 0, output.slice(-5000))
  const result = JSON.parse(readFileSync(join(artifact, 'result.json'), 'utf8'))
  console.log(
    JSON.stringify(
      {
        measures: result.measures,
        projection: result.core[0],
        worstTaskMs: Math.max(...result.tasks.map((t) => t.ms)),
        worstDispatchMs: Math.max(
          ...result.metrics.filter((t) => t.stage === 'replica-dispatch').map((t) => t.ms),
        ),
      },
      null,
      2,
    ),
  )
  if (label !== 'baseline')
    for (const m of result.measures)
      if (m.feedbackMs !== undefined) assert.ok(m.feedbackMs < 100, `${m.name}: ${m.feedbackMs}ms`)
} finally {
  clearTimeout(timer)
  desktop.kill()
  await vite.close()
  rmSync(scratch, { recursive: true, force: true })
}
